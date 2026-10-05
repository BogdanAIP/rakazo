import { describe, expect, it } from "vitest";
import {
  loadChatGptContext,
  loadChatGptProjectContext,
  searchChatGptCapabilities,
} from "./chatgpt-context.js";

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

  it("loads selected project context by slug", async () => {
    const answers: Record<string, unknown> = {
      "bots/list": [{ id: "bot-1", name: "Test", status: "idle" }],
      "memory/list": [],
      "scratchpad/list": [],
      "projects/list": [
        { id: "project-1", slug: "rakazo", name: "Rakazo", description: "", memoryRevision: 1 },
      ],
      "projects/context": {
        project: {
          id: "project-1",
          slug: "rakazo",
          name: "Rakazo",
          description: "",
          memoryRevision: 1,
          memory: "Project memory",
        },
        resources: [
          {
            id: "resource-1",
            projectId: "project-1",
            kind: "github.repo",
            ref: "BogdanAIP/rakazo",
            label: "Repo",
            metadata: {},
          },
        ],
        openTasks: [{ id: "task-1", title: "Continue", status: "open", notes: "Next step" }],
      },
      "agentSkills/list": [],
      "runs/list": { runs: [] },
      "routines/list": [],
      "capabilities/list": [],
    };
    const calls: string[] = [];
    const read = async (name: string): Promise<unknown> => {
      calls.push(name);
      if (!(name in answers)) throw new Error(`Unexpected procedure: ${name}`);
      return answers[name];
    };
    const output = await loadChatGptContext(read, "bot-1", { projectSlug: "rakazo" });
    expect(output.selectedProject).toMatchObject({
      project: { id: "project-1", slug: "rakazo", text: "Project memory", truncated: false },
      resources: [{ kind: "github.repo", ref: "BogdanAIP/rakazo" }],
      openTasks: [{ id: "task-1", title: "Continue", text: "Next step", truncated: false }],
    });
    expect(calls).toContain("projects/context");
    await expect(loadChatGptContext(read, "bot-1", { projectSlug: "missing" })).rejects.toThrow(
      "not accessible",
    );
  });

  it("loads project-centric context without selecting a bot", async () => {
    const answers: Record<string, unknown> = {
      "projects/list": [
        {
          id: "project-1",
          slug: "rakazo",
          name: "Rakazo",
          description: "Control plane",
          memoryRevision: 2,
        },
      ],
      "projects/context": {
        project: {
          id: "project-1",
          slug: "rakazo",
          name: "Rakazo",
          description: "Control plane",
          memoryRevision: 2,
          memory: "Canonical project memory",
        },
        resources: [
          {
            id: "bot-resource",
            kind: "rakazo.bot",
            ref: "bot-2",
            label: "Worker",
            metadata: {},
          },
          {
            id: "worktree-resource",
            kind: "workspace.worktree",
            ref: "C:/work/rakazo",
            label: "Project checkout",
            metadata: { branch: "feature/project" },
          },
        ],
        openTasks: [
          {
            id: "task-1",
            botId: "bot-1",
            projectId: "project-1",
            title: "Continue",
            status: "open",
            notes: "Next",
          },
        ],
      },
      "bots/list": [
        { id: "bot-1", name: "ChatGPT Windows", status: "idle", computerMode: "dedicated" },
        { id: "bot-2", name: "Worker", status: "running", computerMode: "team" },
        { id: "bot-3", name: "Unrelated", status: "idle", computerMode: "team" },
      ],
      "agentSkills/list": [],
      "runs/list": {
        runs: [
          { runId: "run-1", botId: "bot-1", status: "running" },
          { runId: "run-2", botId: "bot-2", status: "queued" },
          { runId: "run-3", botId: "bot-3", status: "running" },
        ],
      },
      "capabilities/list": [],
    };
    const read = async (name: string): Promise<unknown> => {
      if (!(name in answers)) throw new Error("Unexpected procedure: " + name);
      return answers[name];
    };

    const output = await loadChatGptProjectContext(read, { projectSlug: "rakazo" });

    expect(output.project).toMatchObject({
      id: "project-1",
      slug: "rakazo",
      text: "Canonical project memory",
      truncated: false,
    });
    expect(output.linkedBots).toEqual([
      expect.objectContaining({
        id: "bot-1",
        name: "ChatGPT Windows",
        linkSources: ["task"],
      }),
      expect.objectContaining({
        id: "bot-2",
        name: "Worker",
        linkSources: ["resource"],
      }),
    ]);
    expect(output.worktrees).toEqual([
      expect.objectContaining({ kind: "workspace.worktree", ref: "C:/work/rakazo" }),
    ]);
    expect(output.activeRuns).toEqual([
      expect.objectContaining({ runId: "run-2", botId: "bot-2" }),
    ]);
    expect(output.counts).toMatchObject({
      linkedBots: 2,
      explicitBots: 1,
      taskBots: 1,
      worktrees: 1,
      activeRuns: 1,
    });
    expect(output.compiledContext).toMatchObject({
      schemaVersion: "rccl-v1",
      project: { id: "project-1", slug: "rakazo", memoryRevision: 2 },
      authority: {
        sourceTextIsContextOnly: true,
        liveVerificationRequiredBeforeWrites: true,
        compilerUsesModel: false,
      },
    });
    expect((output.compiledContext as { rendered: string }).rendered).toContain(
      '[PROJECT] id="project-1"',
    );
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
