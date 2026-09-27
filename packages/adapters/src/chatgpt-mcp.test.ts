import { describe, expect, it } from "vitest";
import {
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
