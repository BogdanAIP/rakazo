import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsProcessBackend } from "./native-process.js";
import { parseTrustedExecRoots, resolveTrustedExecDirectory } from "./trusted-exec-directory.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "windows-exec-roots-"));
  cleanups.push(home);
  const stateDir = path.join(home, "state");
  const allowed = path.join(home, "trusted-repository");
  const nested = path.join(allowed, "subdir");
  const other = path.join(home, "another-repository");
  await mkdir(nested, { recursive: true });
  await mkdir(other, { recursive: true });
  return { stateDir, allowed, nested, other };
}

describe("trusted Windows process working directories", () => {
  it("does not trust arbitrary absolute paths by default", async () => {
    const { stateDir, allowed } = await fixture();
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const backend = new WindowsProcessBackend(stateDir, runner, true, {});
    await expect(backend.execute("bot-a", ["git", "status"], allowed)).rejects.toThrow(
      "outside the registered trusted directories",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("allows configured repository roots and contained directories only for the named bot", async () => {
    const { stateDir, allowed, nested, other } = await fixture();
    const runner = vi.fn(async (_argv: string[], cwd: string) => ({
      stdout: cwd,
      stderr: "",
      code: 0,
    }));
    const backend = new WindowsProcessBackend(stateDir, runner, true, { "bot-a": [allowed] });
    await expect(backend.execute("bot-a", ["git", "status"], allowed)).resolves.toMatchObject({
      stdout: await resolveTrustedExecDirectory("bot-a", allowed, { "bot-a": [allowed] }),
    });
    await expect(backend.execute("bot-a", ["git", "status"], nested)).resolves.toMatchObject({
      stdout: await resolveTrustedExecDirectory("bot-a", nested, { "bot-a": [allowed] }),
    });
    await expect(backend.execute("bot-b", ["git", "status"], allowed)).rejects.toThrow(
      "outside the registered trusted directories",
    );
    await expect(backend.execute("bot-a", ["git", "status"], other)).rejects.toThrow(
      "outside the registered trusted directories",
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("retains dedicated workspace access for relative cwd", async () => {
    const { stateDir } = await fixture();
    const runner = vi.fn(async (_argv: string[], cwd: string) => ({
      stdout: cwd,
      stderr: "",
      code: 0,
    }));
    const backend = new WindowsProcessBackend(stateDir, runner, true, {});
    const result = await backend.execute("bot-a", ["git", "status"], ".");
    expect(result.stdout).toContain(path.join("workspaces", "bot-a"));
  });

  it("rejects links, traversal and escaping paths even under a registered root", async () => {
    const { stateDir, allowed, other } = await fixture();
    await symlink(other, path.join(allowed, "linked"), process.platform === "win32" ? "junction" : "dir");
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const backend = new WindowsProcessBackend(stateDir, runner, true, { "bot-a": [allowed] });
    await expect(backend.execute("bot-a", ["git"], path.join(allowed, "linked"))).rejects.toThrow(
      "link",
    );
    await expect(backend.execute("bot-a", ["git"], `${allowed}${path.sep}..${path.sep}another-repository`)).rejects.toThrow();
    await expect(backend.execute("bot-a", ["git"], path.parse(allowed).root)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts only a bounded host-managed JSON mapping", () => {
    const root = path.join(os.tmpdir(), "trusted-exec-example");
    expect(parseTrustedExecRoots()).toEqual({});
    expect(parseTrustedExecRoots(JSON.stringify({ "bot-a": [root] }))).toEqual({ "bot-a": [root] });
    expect(() => parseTrustedExecRoots("{oops")).toThrow("Invalid RAKAZO_WINDOWS");
    expect(() => parseTrustedExecRoots(JSON.stringify([root]))).toThrow("per-bot");
    expect(() => parseTrustedExecRoots(JSON.stringify({ "bot-a": ["../repo"] }))).toThrow("absolute");
    expect(() => parseTrustedExecRoots(JSON.stringify({ "bot-a": [path.parse(root).root] }))).toThrow("root");
    expect(() => parseTrustedExecRoots(JSON.stringify({ "bot-a": Array(9).fill(root) }))).toThrow("mapping");
    expect(() => parseTrustedExecRoots(JSON.stringify({ "../bad": [root] }))).toThrow("mapping");
  });
});
