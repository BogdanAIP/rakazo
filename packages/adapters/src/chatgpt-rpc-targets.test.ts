import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredRpcTarget, RpcTargetsSchema } from "./chatgpt-rpc-targets.js";

const target = {
  name: "paper-fixture",
  apiUrl: "http://127.0.0.1:3999",
  origin: "http://localhost:4999",
  spaceId: "fixture-space",
  accessToken: "rkg_" + "a".repeat(43),
  procedures: ["trading/perpetualWorkspaceRead"],
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("scoped local RPC targets", () => {
  it("loads a scoped credential from its named environment variable without borrowing a default session", () => {
    const dir = mkdtempSync(join(tmpdir(), "rakazo-rpc-env-"));
    try {
      const file = join(dir, "targets.json");
      const fromEnv = { ...target, accessToken: undefined, accessTokenEnv: "RAKAZO_RPC_KEY_PAPER" };
      writeFileSync(file, JSON.stringify({ targets: [fromEnv] }));
      vi.stubEnv("RAKAZO_RPC_TARGETS_FILE", file);
      vi.stubEnv("RAKAZO_RPC_KEY_PAPER", "");
      vi.stubEnv("RAKAZO_SESSION_TOKEN", "fixture-default-session");
      expect(configuredRpcTarget("projects/list")).toBeUndefined();
      expect(() => configuredRpcTarget(target.procedures[0]!)).toThrow(
        "configuration is unavailable or invalid",
      );
      vi.stubEnv("RAKAZO_RPC_KEY_PAPER", target.accessToken);
      expect(configuredRpcTarget(target.procedures[0]!)).toMatchObject({
        accessToken: target.accessToken,
        accessTokenEnv: "RAKAZO_RPC_KEY_PAPER",
      });
      expect(
        RpcTargetsSchema.safeParse({
          targets: [{ ...target, accessTokenEnv: "RAKAZO_RPC_KEY_PAPER" }],
        }).success,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps default and scoped credentials separate and never falls back after a target failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rakazo-rpc-transport-"));
    try {
      const file = join(dir, "targets.json");
      writeFileSync(file, JSON.stringify({ targets: [target] }));
      vi.stubEnv("RAKAZO_RPC_TARGETS_FILE", file);
      vi.stubEnv("RAKAZO_API_URL", "http://127.0.0.1:3998");
      vi.stubEnv("RAKAZO_SESSION_TOKEN", "fixture-default-session");
      const calls: Array<{
        url: string;
        authorization: string | null;
        redirect?: RequestRedirect;
      }> = [];
      vi.stubGlobal("fetch", async (request: Request, init?: RequestInit) => {
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          redirect: init?.redirect,
        });
        return new Response(JSON.stringify({ json: { ok: true } }), {
          headers: { "content-type": "application/json" },
        });
      });
      const { callRakazoRpc } = await import("./chatgpt-rakazo.js");
      await callRakazoRpc("trading/perpetualWorkspaceRead", { ledgerId: "paper-futures:fixture" });
      await callRakazoRpc("projects/list", {});
      expect(calls[0]).toMatchObject({
        authorization: "Bearer " + target.accessToken,
        redirect: "error",
      });
      expect(calls[0]!.url).toContain(":3999/rpc/");
      expect(calls[1]).toMatchObject({ authorization: "Bearer fixture-default-session" });
      expect(calls[1]!.url).toContain(":3998/rpc/");
      let failures = 0;
      vi.stubGlobal("fetch", async () => {
        failures++;
        throw new Error("fixture target unavailable");
      });
      await expect(
        callRakazoRpc("trading/perpetualWorkspaceRead", { ledgerId: "paper-futures:fixture" }),
      ).rejects.toThrow();
      expect(failures).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes exact procedure names without capturing other namespaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "rakazo-rpc-target-"));
    try {
      const file = join(dir, "targets.json");
      writeFileSync(file, JSON.stringify({ targets: [target] }));
      vi.stubEnv("RAKAZO_RPC_TARGETS_FILE", file);
      expect(configuredRpcTarget("trading/perpetualWorkspaceRead")).toEqual(target);
      expect(configuredRpcTarget("projects/list")).toBeUndefined();
      expect(configuredRpcTarget("trading/perpetualWorkspaceCommand")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses non-loopback destinations, embedded credentials, duplicate and wildcard routes", () => {
    for (const apiUrl of [
      "https://example.test",
      "http://user:secret@127.0.0.1",
      "http://127.0.0.1/private",
      "file:///tmp/target",
    ]) {
      expect(RpcTargetsSchema.safeParse({ targets: [{ ...target, apiUrl }] }).success).toBe(false);
    }
    expect(
      RpcTargetsSchema.safeParse({ targets: [target, { ...target, name: "second" }] }).success,
    ).toBe(false);
    expect(
      RpcTargetsSchema.safeParse({ targets: [{ ...target, procedures: ["trading/*"] }] }).success,
    ).toBe(false);
    expect(
      RpcTargetsSchema.safeParse({
        targets: [{ ...target, accessToken: "a-normal-session-token" }],
      }).success,
    ).toBe(false);
  });
  it("fails closed without echoing malformed secret configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "rakazo-rpc-target-"));
    try {
      const file = join(dir, "targets.json");
      writeFileSync(file, '{"accessToken":"private-fixture-secret');
      vi.stubEnv("RAKAZO_RPC_TARGETS_FILE", file);
      expect(() => configuredRpcTarget("trading/list")).toThrow(
        "configuration is unavailable or invalid",
      );
      try {
        configuredRpcTarget("trading/list");
      } catch (error) {
        expect(String(error)).not.toContain("private-fixture-secret");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
