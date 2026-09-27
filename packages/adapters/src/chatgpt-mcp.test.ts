import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  callRakazoRpc,
  classifyProcedure,
  describeProcedure,
  discoverProcedurePaths,
  loadProcedureCatalog,
} from "./chatgpt-rakazo.js";

describe("ChatGPT Rakazo procedure projection", () => {
  it("discovers the live appContract", () => {
    const procedures = discoverProcedurePaths();

    expect(procedures.length).toBeGreaterThan(150);
    expect(procedures).toContain("bots/list");
    expect(procedures).toContain("threads/send");
    expect(procedures).toContain("threads/subscribe");
    expect(procedures).toContain("computer/input");
    expect(procedures).toContain("memory/update");
    expect(procedures).toContain("routines/create");
    expect(procedures).toContain("mcp/servers/create");
    expect(procedures).toContain("connections/tools");
    expect(procedures).toContain("artifacts/getById");
    expect(procedures).toContain("agentSecrets/remove");
    expect(new Set(procedures).size).toBe(procedures.length);
  });

  it("returns concrete JSON input schemas from the runtime contract", async () => {
    const description = await describeProcedure("threads/send");
    const input = description.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
    };

    expect(description.mode).toBe("write");
    expect(input.type).toBe("object");
    expect(input.properties).toHaveProperty("botId");
    expect(input.properties).toHaveProperty("groupId");
    expect(input.properties).toHaveProperty("text");
    expect(input.properties).toHaveProperty("artifactIds");
    expect(input.properties).toHaveProperty("clientNonce");
  });

  it("uses Rakazo's oRPC transport with bearer and space context", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.RAKAZO_SESSION_TOKEN;
    const originalApiUrl = process.env.RAKAZO_API_URL;
    const originalOrigin = process.env.RAKAZO_ORIGIN;
    const originalSpaceId = process.env.RAKAZO_SPACE_ID;
    let requestSnapshot:
      | { url: string; method: string; authorization: string | null; spaceId: string | null; body: string }
      | undefined;

    process.env.RAKAZO_SESSION_TOKEN = "test-session-token";
    process.env.RAKAZO_API_URL = "http://127.0.0.1:3100";
    process.env.RAKAZO_ORIGIN = "http://127.0.0.1:5173";
    process.env.RAKAZO_SPACE_ID = "test-space";

    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestSnapshot = {
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        spaceId: request.headers.get("x-rakazo-space-id"),
        body: await request.clone().text(),
      };
      return new Response(JSON.stringify({ json: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await expect(callRakazoRpc("search/query", { q: "rakazo" })).resolves.toEqual({ ok: true });
      expect(requestSnapshot).toEqual({
        url: "http://127.0.0.1:3100/rpc/search/query",
        method: "POST",
        authorization: "Bearer test-session-token",
        spaceId: "test-space",
        body: JSON.stringify({ json: { q: "rakazo" } }),
      });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv("RAKAZO_SESSION_TOKEN", originalToken);
      restoreEnv("RAKAZO_API_URL", originalApiUrl);
      restoreEnv("RAKAZO_ORIGIN", originalOrigin);
      restoreEnv("RAKAZO_SPACE_ID", originalSpaceId);
    }
  });

  it("separates read, write, destructive, and stream calls", () => {
    expect(classifyProcedure("bots/list")).toBe("read");
    expect(classifyProcedure("threads/send")).toBe("write");
    expect(classifyProcedure("bots/remove")).toBe("destructive");
    expect(classifyProcedure("bots/rotateWebhookSecret")).toBe("destructive");
    expect(classifyProcedure("updater/apply")).toBe("destructive");
    expect(classifyProcedure("threads/subscribe")).toBe("stream");
  });

  it("classifies every current procedure", async () => {
    const catalog = await loadProcedureCatalog();
    expect(catalog.every((entry) => entry.procedure && entry.mode)).toBe(true);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
