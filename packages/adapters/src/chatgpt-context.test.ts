import { describe, expect, it } from "vitest";
import { loadChatGptContext } from "./chatgpt-context.js";

describe("ChatGPT shared context", () => {
  it("loads one bot's state without mutations", async () => {
    const answers: Record<string, unknown> = {
      "bots/list": [{ id: "bot-1", name: "Test", status: "idle" }],
      "memory/list": [{ id: "m", content: "Shared", revision: 1 }],
      "scratchpad/list": [],
      "agentSkills/list": [],
      "runs/list": { runs: [] },
      "routines/list": [],
      "capabilities/list": [],
    };
    const calls: string[] = [];
    const output = await loadChatGptContext(async (name) => {
      calls.push(name);
      return answers[name];
    });
    expect(output.bot).toEqual({ id: "bot-1", name: "Test", status: "idle" });
    expect(calls).toContain("memory/list");
    expect(calls).not.toContain("memory/update");
  });
});
