import { describe, expect, it } from "vitest";
import {
  manageProjectWorktree,
  parseGitWorktreePorcelain,
  type RakazoCaller,
} from "./chatgpt-worktree.js";

describe("ChatGPT project worktree manager", () => {
  it("parses git worktree porcelain output", () => {
    expect(
      parseGitWorktreePorcelain(
        [
          "worktree C:/Users/test/rakazo",
          "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "branch refs/heads/main",
          "",
          "worktree C:/Users/test/rakazo-task",
          "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "detached",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "C:/Users/test/rakazo",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "main",
        detached: false,
      },
      {
        path: "C:/Users/test/rakazo-task",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        detached: true,
      },
    ]);
  });

  it("lists worktrees only after project repository and origin verification", async () => {
    const calls: Array<{ procedure: string; input?: Record<string, unknown> }> = [];
    const call: RakazoCaller = async (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "projects/context") {
        return {
          project: { id: "project-1" },
          resources: [
            { kind: "github.repo", ref: "BogdanAIP/rakazo" },
            {
              kind: "workspace.worktree",
              ref: "C:/Users/test/rakazo-task",
              metadata: { branch: "feature/task" },
            },
          ],
          openTasks: [],
        };
      }
      if (procedure === "computer/takeover") return { leaseId: "lease", expiresAt: "later" };
      if (procedure === "computer/exec") {
        const argv = input?.argv as string[];
        const joined = argv.join(" ");
        if (joined.includes("remote get-url origin")) {
          return { stdout: "https://github.com/BogdanAIP/rakazo.git\n", stderr: "", code: 0 };
        }
        if (joined.includes("worktree list --porcelain")) {
          return {
            stdout: [
              "worktree C:/Users/test/rakazo",
              "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "branch refs/heads/main",
              "",
              "worktree C:/Users/test/rakazo-task",
              "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "branch refs/heads/feature/task",
              "",
            ].join("\n"),
            stderr: "",
            code: 0,
          };
        }
      }
      throw new Error("Unexpected procedure: " + procedure);
    };

    const result = await manageProjectWorktree(call, {
      action: "list",
      projectId: "project-1",
      computerBotId: "windows-bot",
      repository: "BogdanAIP/rakazo",
      repoPath: "C:/Users/test/rakazo",
    });

    expect(result.worktrees).toEqual([
      expect.objectContaining({ path: "C:/Users/test/rakazo", branch: "main" }),
      expect.objectContaining({ path: "C:/Users/test/rakazo-task", branch: "feature/task" }),
    ]);
    expect(result.registeredWorktrees).toEqual([
      expect.objectContaining({ ref: "C:/Users/test/rakazo-task" }),
    ]);
    expect(calls.map((item) => item.procedure)).toEqual([
      "projects/context",
      "computer/takeover",
      "computer/exec",
      "computer/exec",
    ]);
  });

  it("ensures a new branch worktree and registers it only after verification", async () => {
    let listed = 0;
    let upserted = false;
    const call: RakazoCaller = async (procedure, input) => {
      if (procedure === "projects/context") {
        return {
          project: { id: "project-1" },
          resources: [{ kind: "github.repo", ref: "BogdanAIP/rakazo" }],
          openTasks: [],
        };
      }
      if (procedure === "computer/takeover") return { leaseId: "lease", expiresAt: "later" };
      if (procedure === "projects/resources/upsert") {
        upserted = true;
        expect(input).toMatchObject({
          projectId: "project-1",
          kind: "workspace.worktree",
          ref: "C:/Users/test/rakazo-task",
          metadata: {
            repo: "BogdanAIP/rakazo",
            branch: "feature/task",
            computerBotId: "windows-bot",
            head: "cccccccccccccccccccccccccccccccccccccccc",
          },
        });
        return { id: "resource-1", ...input };
      }
      if (procedure !== "computer/exec") throw new Error("Unexpected procedure: " + procedure);

      const argv = input?.argv as string[];
      const joined = argv.join(" ");
      if (joined.includes("remote get-url origin")) {
        return { stdout: "git@github.com:BogdanAIP/rakazo.git\n", stderr: "", code: 0 };
      }
      if (joined.includes("worktree list --porcelain")) {
        listed += 1;
        return {
          stdout:
            listed === 1
              ? [
                  "worktree C:/Users/test/rakazo",
                  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "branch refs/heads/main",
                  "",
                ].join("\n")
              : [
                  "worktree C:/Users/test/rakazo",
                  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "branch refs/heads/main",
                  "",
                  "worktree C:/Users/test/rakazo-task",
                  "HEAD cccccccccccccccccccccccccccccccccccccccc",
                  "branch refs/heads/feature/task",
                  "",
                ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      if (joined.includes("check-ref-format --branch feature/task")) {
        return { stdout: "feature/task\n", stderr: "", code: 0 };
      }
      if (joined.includes("show-ref --verify --quiet refs/heads/feature/task")) {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (joined.includes("rev-parse --verify aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{commit}")) {
        return {
          stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
          stderr: "",
          code: 0,
        };
      }
      if (joined.includes("worktree add -b feature/task")) {
        expect(argv).toEqual([
          "git",
          "-C",
          "C:/Users/test/rakazo",
          "worktree",
          "add",
          "-b",
          "feature/task",
          "C:\\Users\\test\\rakazo-task",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ]);
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      }
      if (joined.includes("rev-parse --show-toplevel")) {
        return { stdout: "C:/Users/test/rakazo-task\n", stderr: "", code: 0 };
      }
      if (joined.includes("branch --show-current")) {
        return { stdout: "feature/task\n", stderr: "", code: 0 };
      }
      if (joined.endsWith("rev-parse HEAD")) {
        return {
          stdout: "cccccccccccccccccccccccccccccccccccccccc\n",
          stderr: "",
          code: 0,
        };
      }
      throw new Error("Unexpected git argv: " + joined);
    };

    const result = await manageProjectWorktree(call, {
      action: "ensure",
      projectId: "project-1",
      computerBotId: "windows-bot",
      repository: "BogdanAIP/rakazo",
      repoPath: "C:/Users/test/rakazo",
      worktreePath: "C:\\Users\\test\\rakazo-task",
      branch: "feature/task",
      baseRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(upserted).toBe(true);
    expect(result).toMatchObject({
      created: true,
      worktree: {
        path: "C:/Users/test/rakazo-task",
        branch: "feature/task",
        head: "cccccccccccccccccccccccccccccccccccccccc",
      },
    });
  });

  it("rejects option-shaped worktree paths before computer takeover", async () => {
    const calls: string[] = [];
    const call: RakazoCaller = async (procedure) => {
      calls.push(procedure);
      throw new Error("Unexpected procedure: " + procedure);
    };

    await expect(
      manageProjectWorktree(call, {
        action: "ensure",
        projectId: "project-1",
        computerBotId: "windows-bot",
        repository: "BogdanAIP/rakazo",
        repoPath: "C:/Users/test/rakazo",
        worktreePath: "--force",
        branch: "feature/task",
        baseRef: "origin/main",
      }),
    ).rejects.toThrow("worktreePath must be an absolute path");
    expect(calls).toEqual([]);
  });

  it("fails closed when local origin does not match the project repository", async () => {
    let mutationAfterTakeover = false;
    const call: RakazoCaller = async (procedure, input) => {
      if (procedure === "projects/context") {
        return {
          project: { id: "project-1" },
          resources: [{ kind: "github.repo", ref: "BogdanAIP/rakazo" }],
          openTasks: [],
        };
      }
      if (procedure === "computer/takeover") return { leaseId: "lease", expiresAt: "later" };
      if (procedure === "computer/exec") {
        const argv = input?.argv as string[];
        if (argv.join(" ").includes("remote get-url origin")) {
          return { stdout: "https://github.com/other/repo.git\n", stderr: "", code: 0 };
        }
        mutationAfterTakeover = true;
      }
      if (procedure === "projects/resources/upsert") mutationAfterTakeover = true;
      throw new Error("Unexpected procedure: " + procedure);
    };

    await expect(
      manageProjectWorktree(call, {
        action: "ensure",
        projectId: "project-1",
        computerBotId: "windows-bot",
        repository: "BogdanAIP/rakazo",
        repoPath: "C:/Users/test/rakazo",
        worktreePath: "C:/Users/test/rakazo-task",
        branch: "feature/task",
        baseRef: "origin/main",
      }),
    ).rejects.toThrow("Local origin does not match project repository");
    expect(mutationAfterTakeover).toBe(false);
  });
});
