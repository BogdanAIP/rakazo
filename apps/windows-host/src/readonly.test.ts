import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTasklistCsv, WindowsHostReadOnlyBackend } from "./readonly.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function testWorkspace() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "windows-readonly-"));
  temporaryDirectories.push(stateDir);
  const root = path.join(stateDir, "workspaces", "bot-a");
  await mkdir(root, { recursive: true });
  return { stateDir, root };
}

describe("WindowsHostReadOnlyBackend", () => {
  it("parses a bounded native Windows process inventory", async () => {
    const parsed = parseTasklistCsv(
      '"notepad.exe","1234","Console","1","12,345 K"\r\n"test.exe","4321","Console","1","1 K"\r\n',
      1,
    );
    expect(parsed).toEqual([{ pid: 1234, name: "notepad.exe" }]);

    const backend = new WindowsHostReadOnlyBackend("unused", async () => [
      { pid: 1234, name: "notepad.exe" },
      { pid: 4321, name: "test.exe" },
    ]);
    await expect(backend.listProcesses(1)).resolves.toEqual([{ pid: 1234, name: "notepad.exe" }]);
    await expect(backend.listProcesses(101)).rejects.toThrow("limit");
  });

  it("lists and reads only a dedicated bot workspace with bounded bytes", async () => {
    const { stateDir, root } = await testWorkspace();
    await writeFile(path.join(root, "sample.txt"), "HELLO");
    const backend = new WindowsHostReadOnlyBackend(stateDir, async () => []);

    await expect(backend.listFiles("bot-a", ".")).resolves.toEqual([
      { path: "sample.txt", kind: "file", size: 5 },
    ]);
    await expect(backend.readFile("bot-a", "sample.txt", 5)).resolves.toEqual(
      new Uint8Array(Buffer.from("HELLO")),
    );
    await expect(backend.readFile("bot-a", "sample.txt", 4)).rejects.toThrow("exceeds");
  });

  it("rejects traversal, absolute paths and links outside the workspace", async () => {
    const { stateDir, root } = await testWorkspace();
    const secret = path.join(stateDir, "secret.txt");
    await writeFile(secret, "NOT_FOR_HOST_TOOLS");
    await symlink(secret, path.join(root, "link.txt"));
    const backend = new WindowsHostReadOnlyBackend(stateDir, async () => []);

    await expect(backend.readFile("bot-a", "../secret.txt", 128)).rejects.toThrow();
    await expect(backend.readFile("bot-a", secret, 128)).rejects.toThrow();
    await expect(backend.readFile("bot-a", "link.txt", 128)).rejects.toThrow("links");
    await expect(backend.listFiles("bot-a", ".")).resolves.toEqual([]);
  });
});
