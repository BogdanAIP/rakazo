import { describe, expect, it } from "vitest";
import { loadChatGptContext, searchChatGptCapabilities } from "./chatgpt-context.js";

describe("ChatGPT shared context", () => {
  it("loads one bot's state without mutations", async () => {
    const answers: Record<string, unknown> = {
      "bots/list": [{ id: "bot-1", name: "Test", status: "idle" }],
      "memory/list": [{ id: "m", content: "Shared", revision: 1 }],
      "scratchpad/list": [],
      "projects/list": [
        {
          id: "project-1",
          slug: "rakazo",
          name: "Rakazo",
          description: "Control plane",
          memoryRevision: 1,
        },
      ],
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
    expect(output.projects).toEqual([
      {
        id: "project-1",
        slug: "rakazo",
        name: "Rakazo",
        description: "Control plane",
        memoryRevision: 1,
        updatedAt: undefined,
      },
    ]);
    expect(calls).not.toContain("memory/update");
  });
  it("requires an explicit bot when more than one exists", async () => {
    const read = async (name: string): Promise<unknown> =>
      name === "bots/list" ? [{ id: "one" }, { id: "two" }] : [];
    await expect(loadChatGptContext(read)).rejects.toThrow("Specify botId");
    await expect(loadChatGptContext(read, "missing")).rejects.toThrow("not accessible");
  });

  it("capability search discovers without installing or executing", async () => {
    const calls: string[] = [];
    const output = await searchChatGptCapabilities(
      async (name) => {
        calls.push(name);
        if (name === "capabilities/list") return [{ id: "installed", name: "Learn", kind: "mcp" }];
        if (name === "capabilities/catalogSearch") {
          return {
            enabled: true,
            results: [{ name: "Learn", domain: "microsoft.com", surfaces: [] }],
          };
        }
        throw new Error("Unexpected procedure");
      },
      "learn",
      true,
    );
    expect(output.publicCatalogEnabled).toBe(true);
    expect(output.resultCount).toBe(1);
    expect(calls).toEqual(["capabilities/list", "capabilities/catalogSearch"]);
  });
});
