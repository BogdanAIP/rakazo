import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  classifyProcedure,
  describeProcedureSource,
  discoverProcedurePaths,
  loadProcedureCatalog,
} from "./chatgpt-rakazo.js";

describe("ChatGPT Rakazo procedure projection", () => {
  it("discovers the live appContract without leaking schema fields", async () => {
    const source = await readFile(new URL("../../contracts/src/rpc.ts", import.meta.url), "utf8");
    const procedures = discoverProcedurePaths(source);

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
    expect(procedures).not.toContain("threads/send/taskId");
    expect(new Set(procedures).size).toBe(procedures.length);
  });

  it("returns the live contract signature for a procedure", async () => {
    const source = await readFile(new URL("../../contracts/src/rpc.ts", import.meta.url), "utf8");
    const signature = describeProcedureSource(source, "threads/send");

    expect(signature).toContain("send: oc.input(threadSendInput)");
    expect(signature).toContain("taskId: Id");
    expect(signature).not.toContain("react: oc");
  });

  it("separates read, write, destructive, and stream calls", () => {
    expect(classifyProcedure("bots/list")).toBe("read");
    expect(classifyProcedure("threads/send")).toBe("write");
    expect(classifyProcedure("bots/remove")).toBe("destructive");
    expect(classifyProcedure("updater/apply")).toBe("destructive");
    expect(classifyProcedure("threads/subscribe")).toBe("stream");
  });

  it("classifies every current procedure", async () => {
    const catalog = await loadProcedureCatalog();
    expect(catalog.every((entry) => entry.procedure && entry.mode)).toBe(true);
  });
});
