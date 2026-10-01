/**
 * Physical Windows-only, isolated read-only handle bridge test.
 *
 * Uses a disposable directory under os.tmpdir(). Run before windows-smoke.ts
 * to independently validate Node fd -> libuv HANDLE -> NtCreateFile child ->
 * libuv fd -> Windows final path, without writing through the native backend.
 */
import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openChildDirectoryViaDirectoryFdWin32,
  pathFromDirectoryFd,
  type Win32FileHandle,
  win32NtRelativeAvailable,
} from "@rakazo/adapters/win32-relative-path";

if (process.platform !== "win32") throw new Error("Windows-only native handle smoke");

const rootPath = await mkdtemp(path.join(os.tmpdir(), "rakazo-windows-handle-smoke-"));
let root: Awaited<ReturnType<typeof open>> | undefined;
let child: Win32FileHandle | undefined;
const canonical = (value: string) => path.win32.normalize(value).toLowerCase();

try {
  await mkdir(path.join(rootPath, "child"));
  assert.equal(win32NtRelativeAvailable(), true, "Node libuv/Win32 bridge unavailable");
  root = await open(rootPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  assert.equal(canonical(pathFromDirectoryFd(root.fd)), canonical(await realpath(rootPath)));
  console.log("ROOT HANDLE PATH OK");

  // NtCreateFile holds root by HANDLE; uv_open_osfhandle must return a Node fd
  // referencing that same child, rather than a descriptor from another CRT.
  child = openChildDirectoryViaDirectoryFdWin32(root.fd, "child");
  assert.equal(
    canonical(pathFromDirectoryFd(child.fd)),
    canonical(await realpath(path.join(rootPath, "child"))),
  );
  assert.equal((await child.stat()).isDirectory(), true);
  console.log("CHILD HANDLE TO NODE FD OK");
} finally {
  await child?.close().catch(() => undefined);
  await root?.close().catch(() => undefined);
  await rm(rootPath, { recursive: true, force: true });
}
