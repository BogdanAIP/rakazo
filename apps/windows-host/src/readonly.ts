import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILE_ENTRIES = 128;
const MAX_READ_BYTES = 65_536;
const MAX_TASKLIST_OUTPUT_BYTES = 1024 * 1024;

export interface WindowsProcessEntry {
  pid: number;
  name: string;
}

export interface WindowsFileEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
}

export function parseTasklistCsv(text: string, limit: number): WindowsProcessEntry[] {
  const processes: WindowsProcessEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^"((?:[^"]|"")*)","([0-9]+)"/u.exec(line);
    if (!match) continue;
    const pid = Number(match[2]);
    const name = match[1]!.replace(/""/gu, '"').trim();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name || name.length > 256) continue;
    processes.push({ pid, name });
    if (processes.length >= limit) break;
  }
  return processes;
}

async function listNativeProcesses(): Promise<WindowsProcessEntry[]> {
  if (process.platform !== "win32") {
    throw new Error("Windows process inventory requires an interactive Windows host");
  }
  const tasklist = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
  const { stdout } = await execFileAsync(tasklist, ["/fo", "csv", "/nh"], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: MAX_TASKLIST_OUTPUT_BYTES,
    encoding: "utf8",
  });
  return parseTasklistCsv(stdout, 100);
}

/**
 * Initial read-only host capability. Only the dedicated Rakazo bot workspace is
 * visible; the state directory and DPAPI credential are never exposed.
 * Mutable file operations require durable operation receipts and native
 * Windows handle-relative containment before this becomes production-ready.
 */
export class WindowsHostReadOnlyBackend {
  constructor(
    private readonly stateDir: string,
    private readonly processes: () => Promise<WindowsProcessEntry[]> = listNativeProcesses,
  ) {}

  async listProcesses(limit: number): Promise<WindowsProcessEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid Windows process-list limit");
    }
    return (await this.processes()).slice(0, limit);
  }

  async listFiles(botId: string, directory: string): Promise<WindowsFileEntry[]> {
    const { target, segments } = await this.resolveTarget(botId, directory);
    const information = await lstat(target);
    if (!information.isDirectory()) throw new Error("Workspace path is not a directory");
    const entries = await readdir(target, { withFileTypes: true });
    if (entries.length > MAX_FILE_ENTRIES) {
      throw new Error("Workspace directory exceeds the bounded listing limit");
    }

    const result: WindowsFileEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const fullPath = path.join(target, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
      result.push({
        path: [...segments, entry.name].join("/"),
        kind: info.isDirectory() ? "dir" : "file",
        size: info.size,
      });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(botId: string, filePath: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
      throw new Error("Invalid bounded Windows file read");
    }
    const { target, segments } = await this.resolveTarget(botId, filePath);
    if (segments.length === 0) throw new Error("Cannot read the workspace directory");

    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Workspace path is not a regular file");
      if (info.size > maxBytes) throw new Error("Workspace file exceeds bounded read size");
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) throw new Error("Workspace file exceeds bounded read size");
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  private async resolveTarget(botId: string, relative: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(botId)) {
      throw new Error("Invalid Windows bot workspace identity");
    }
    const segments = workspaceSegments(relative);
    const workspaceParent = path.join(this.stateDir, "workspaces");
    await mkdir(workspaceParent, { recursive: true });
    if ((await lstat(workspaceParent)).isSymbolicLink()) {
      throw new Error("Workspace directory is a symbolic link");
    }
    const workspace = path.join(workspaceParent, botId);
    await mkdir(workspace, { recursive: true });
    if ((await lstat(workspace)).isSymbolicLink()) {
      throw new Error("Bot workspace is a symbolic link");
    }
    const realWorkspace = await realpath(workspace);

    let target = workspace;
    for (const segment of segments) {
      target = path.join(target, segment);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Workspace links are not accessible");
    }

    const resolved = await realpath(target);
    const relativeToRoot = path.relative(realWorkspace, resolved);
    if (
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error("Workspace path escapes its allowed root");
    }
    return { target: resolved, segments };
  }
}

function workspaceSegments(relative: string): string[] {
  if (
    relative.length > 4_096 ||
    relative.includes("\\0") ||
    path.isAbsolute(relative) ||
    /^[a-zA-Z]:/u.test(relative) ||
    relative.startsWith("\\\\")
  ) {
    throw new Error("Workspace path must be relative");
  }
  const segments = relative.replace(/\\/gu, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw new Error("Workspace path escapes its allowed root");
  }
  return segments.filter((segment) => segment !== ".");
}
