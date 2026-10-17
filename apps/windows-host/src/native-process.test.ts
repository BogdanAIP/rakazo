import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsProcessBackend, windowsProcessEnvironment } from "./native-process.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native process command authority", () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-process-policy-"));
    roots.push(root);
    const argv = ["C:/Tools/node.exe", "--version"];
    const runner = vi.fn(async () => ({ stdout: "fixture", stderr: "", code: 0 }));
    const backend = new WindowsProcessBackend(root, runner, true);
    const policy = { version: 1, commands: [{ botId: "fixture-bot", cwd: ".", argv }] };
    return {
      root,
      argv,
      runner,
      backend,
      policy,
      save: (value: unknown) =>
        writeFile(path.join(root, "native-process-policy.json"), JSON.stringify(value)),
    };
  }

  it("fails closed without a local policy even when the legacy flag is enabled", async () => {
    const f = await fixture();
    expect(f.backend.available()).toBe(false);
    await expect(f.backend.execute("fixture-bot", f.argv)).rejects.toThrow(
      "valid local command policy",
    );
    expect(f.runner).not.toHaveBeenCalled();
  });

  it("runs only the exact locally authorized bot, directory and argument vector", async () => {
    const f = await fixture();
    await f.save(f.policy);
    await expect(f.backend.execute("fixture-bot", f.argv)).resolves.toMatchObject({ code: 0 });
    expect(f.runner).toHaveBeenCalledTimes(1);
    for (const [bot, argv, cwd] of [
      ["other-bot", f.argv, "."],
      ["fixture-bot", [...f.argv, "-e", "process.env"], "."],
      ["fixture-bot", ["cmd.exe", "/c", "set"], "."],
      ["fixture-bot", f.argv, "other"],
    ] as const) {
      await expect(f.backend.execute(bot, [...argv], cwd)).rejects.toThrow("not permitted");
    }
    expect(f.runner).toHaveBeenCalledTimes(1);
    await f.save({ version: 1, commands: [] });
    await expect(f.backend.execute("fixture-bot", f.argv)).rejects.toThrow(
      "valid local command policy",
    );
  });

  it("rejects malformed policies and relative executables", async () => {
    const f = await fixture();
    for (const policy of [
      { version: 2, commands: f.policy.commands },
      { version: 1, commands: [{ botId: "fixture-bot", cwd: ".", argv: ["node.exe"] }] },
      { version: 1, commands: [{ cwd: ".", argv: f.argv }] },
    ]) {
      await f.save(policy);
      await expect(f.backend.execute("fixture-bot", f.argv)).rejects.toThrow(
        "valid local command policy",
      );
    }
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "keeps a daemon credential canary out of a real child",
    async () => {
      const f = await fixture();
      const argv = [
        process.execPath,
        "-e",
        "console.log(process.env.RAKAZO_TEST_HOST_SECRET === undefined)",
      ];
      await f.save({ version: 1, commands: [{ botId: "fixture-bot", cwd: ".", argv }] });
      vi.stubEnv("RAKAZO_TEST_HOST_SECRET", "fixture-daemon-canary");
      try {
        const backend = new WindowsProcessBackend(f.root, undefined, true);
        await expect(backend.execute("fixture-bot", argv)).resolves.toMatchObject({
          code: 0,
          stdout: "true\n",
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("does not inherit credentials, profile paths or executable injection variables", () => {
    expect(
      windowsProcessEnvironment({
        SystemRoot: "C:/Windows",
        TEMP: "C:/Temp",
        RAKAZO_WINDOWS_HOST_PAIRING_TOKEN: "fixture-secret",
        DATABASE_URL: "fixture-secret",
        OPENAI_API_KEY: "fixture-secret",
        NODE_OPTIONS: "--require=untrusted",
        PATH: "C:/untrusted",
        USERPROFILE: "C:/private",
      }),
    ).toEqual({
      SystemRoot: "C:/Windows",
      WINDIR: "C:/Windows",
      PATH: `${path.win32.join("C:/Windows", "System32")};C:/Windows`,
      TEMP: "C:/Temp",
    });
  });
});
