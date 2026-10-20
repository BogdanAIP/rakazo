import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { appendMemoryFact, selectMemoryTools } from "./memory-tools.js";

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

const allThree = [
  tool("remember"),
  tool("recall_memory"),
  tool("save_memory"),
  tool("forget_memory"),
  tool("shell"),
];

describe("selectMemoryTools", () => {
  it("keeps native remember and drops semantic memory tools when unconfigured", () => {
    const names = selectMemoryTools(allThree, false).map((t) => t.name);
    expect(names).toEqual(["remember", "shell"]);
  });

  it("keeps semantic memory tools and drops native remember when configured", () => {
    const names = selectMemoryTools(allThree, true).map((t) => t.name);
    expect(names).toEqual(["recall_memory", "save_memory", "forget_memory", "shell"]);
  });

  it("is a no-op for tool lists with no memory tools at all", () => {
    const shellOnly = [tool("shell")];
    expect(selectMemoryTools(shellOnly, false)).toEqual(shellOnly);
    expect(selectMemoryTools(shellOnly, true)).toEqual(shellOnly);
  });
});

describe("appendMemoryFact", () => {
  it("preserves the existing document and adds the fact", () => {
    expect(appendMemoryFact("Existing rule.\n", "New rule.")).toBe("Existing rule.\nNew rule.\n");
  });

  it("normalizes a fresh fact without changing existing whitespace", () => {
    expect(appendMemoryFact("  Existing.  \n", "  New.  ")).toBe("  Existing.  \nNew.\n");
  });

  it("does not append duplicate lines or multiline blocks", () => {
    expect(appendMemoryFact("one\ntwo\n", "two")).toBe("one\ntwo\n");
    expect(appendMemoryFact("before\nArea:\nBerlin\nafter\n", "Area:\nBerlin")).toBe(
      "before\nArea:\nBerlin\nafter\n",
    );
  });

  it("matches multiline facts across Windows line endings", () => {
    expect(appendMemoryFact("Area:\r\nBerlin\r\n", "Area:\nBerlin")).toBe("Area:\r\nBerlin\r\n");
  });

  it("ignores blank facts but initializes new memory", () => {
    expect(appendMemoryFact("existing\n", " \n ")).toBe("existing\n");
    expect(appendMemoryFact("", "first fact")).toBe("first fact\n");
  });
});
