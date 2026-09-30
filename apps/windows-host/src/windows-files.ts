import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createExclusiveChildViaDirectoryFdWin32,
  mkdirChildViaDirectoryFdWin32,
  openChildDirectoryViaDirectoryFdWin32,
  openExistingChildViaDirectoryFdWin32,
  pathFromDirectoryFd,
  win32NtRelativeAvailable,
  type Win32FileHandle,
} from "@rakazo/adapters/win32-relative-path";

const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const SAFE_BOT_ID = /^[a-zA-Z0-9_-]{1,100}$/u;

export interface WindowsFileWriteResult {
  path: string;
  bytesWritten: number;
}

function workspaceSegments(relative: string): string[] {
  if (
    !relative ||
    relative.length > 4_096 ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    /^[a-zA-Z]:/u.test(relative) ||
    relative.startsWith("\\\\")
  ) {
    throw new Error("Workspace file path must be relative");
  }
  const segments = relative.replace(/\\/gu, "/").split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("Workspace file path escapes its allowed root");
  }
  return segments;
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function validateDirectoryHandle(handle: Win32FileHandle, root: string) {
  const heldPath = pathFromDirectoryFd(handle.fd);
  const named = await lstat(heldPath);
  if (named.isSymbolicLink() || !named.isDirectory()) {
    throw new Error("Workspace directory is a reparse point");
  }
  const resolved = await realpath(heldPath);
  if (!isWithin(root, resolved)) throw new Error("Workspace path escapes its allowed root");
  return resolved;
}

async function validateFileHandle(handle: Win32FileHandle, root: string) {
  const info = await handle.stat({ bigint: true });
  if (!info.isFile() || info.nlink !== 1n) {
    throw new Error("Workspace target is not a regular single-link file");
  }
  const heldPath = pathFromDirectoryFd(handle.fd);
  const named = await lstat(heldPath);
  if (named.isSymbolicLink() || !named.isFile()) {
    throw new Error("Workspace file is a reparse point");
  }
  const resolved = await realpath(heldPath);
  if (!isWithin(root, resolved)) throw new Error("Workspace path escapes its allowed root");
}

export class WindowsHostFileMutationBackend {
  constructor(
    private readonly stateDir: string,
    private readonly enabled = process.env.RAKAZO_WINDOWS_FILE_WRITE_ENABLED === "true",
  ) {}

  available() {
    return process.platform === "win32" && this.enabled && win32NtRelativeAvailable();
  }

  async writeFile(
    botId: string,
    relativePath: string,
    content: Uint8Array,
    executable = false,
  ): Promise<WindowsFileWriteResult> {
    if (!this.enabled) throw new Error("Physical Windows file writes are not enabled");
    if (process.platform !== "win32" || !win32NtRelativeAvailable()) {
      throw new Error("Race-resistant Windows file writes require Win32 relative-handle APIs");
    }
    if (!SAFE_BOT_ID.test(botId)) throw new Error("Invalid Windows bot workspace identity");
    if (content.byteLength > MAX_WRITE_BYTES) {
      throw new Error("Windows file writes are limited to 2 MiB");
    }

    const segments = workspaceSegments(relativePath);
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
    const root = await realpath(workspace);

    let directory = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      await validateDirectoryHandle(directory as unknown as Win32FileHandle, root);
      for (const segment of segments.slice(0, -1)) {
        let next: Win32FileHandle;
        try {
          next = openChildDirectoryViaDirectoryFdWin32(directory.fd, segment);
        } catch (openError) {
          try {
            mkdirChildViaDirectoryFdWin32(directory.fd, segment);
          } catch {
            throw openError;
          }
          next = openChildDirectoryViaDirectoryFdWin32(directory.fd, segment);
        }
        try {
          await validateDirectoryHandle(next, root);
        } catch (error) {
          await next.close().catch(() => undefined);
          throw error;
        }
        await directory.close();
        directory = next as unknown as typeof directory;
      }

      const name = segments.at(-1)!;
      let file: Win32FileHandle;
      try {
        file = openExistingChildViaDirectoryFdWin32(directory.fd, name);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        file = createExclusiveChildViaDirectoryFdWin32(directory.fd, name);
      }

      try {
        await validateFileHandle(file, root);
        await file.truncate(0);
        await file.writeFile(content);
        await file.chmod(executable ? 0o700 : 0o600).catch(() => undefined);
      } finally {
        await file.close().catch(() => undefined);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }

    return { path: segments.join("/"), bytesWritten: content.byteLength };
  }
}
