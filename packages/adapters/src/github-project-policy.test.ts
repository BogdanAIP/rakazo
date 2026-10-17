import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { assertGithubProjectWrite, githubWriteTarget } from "./github-project-policy.js";

const GRANT = {
  ref: "BogdanAIP/rakazo",
  metadata: { githubAccess: "autonomous_write", githubMcpServerId: "github-server" },
};

const context = {
  operationId: "test",
  traceId: "test",
  botId: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
  projectId: "project-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

function fixture(grants: unknown[] = [GRANT], project: unknown = { id: "project-1" }) {
  const projectLookup = vi.fn().mockResolvedValue(project);
  const resourceLookup = vi.fn().mockResolvedValue(grants);
  return {
    prisma: {
      project: { findFirst: projectLookup },
      projectResource: { findMany: resourceLookup },
    } as never,
    projectLookup,
    resourceLookup,
  };
}

describe("project-scoped autonomous GitHub writes", () => {
  it("accepts ordinary repository mutations with canonical case-insensitive names", () => {
    expect(githubWriteTarget("push_files", { owner: "BogdanAIP", repo: "Rakazo" })).toBe(
      "bogdanaip/rakazo",
    );
    expect(
      githubWriteTarget("create_pull_request", {
        owner: "BogdanAIP",
        repo: "rakazo",
        head: "feature/isolated",
        base: "main",
      }),
    ).toBe("bogdanaip/rakazo");
    expect(
      githubWriteTarget("discussion_comment_write", {
        owner: "BogdanAIP",
        repo: "rakazo",
        method: "add",
        discussionNumber: 1,
      }),
    ).toBe("bogdanaip/rakazo");
    expect(
      githubWriteTarget("merge_pull_request", {
        repository_full_name: "BogdanAIP/rakazo",
      }),
    ).toBe("bogdanaip/rakazo");
  });

  it.each([
    ["create_repository", { owner: "BogdanAIP", repo: "rakazo" }],
    ["create_gist", { owner: "BogdanAIP", repo: "rakazo" }],
    ["push_files", { owner: "BogdanAIP" }],
    ["push_files", { owner: "BogdanAIP", repo: "../AIHOT" }],
    ["push_files", { owner: "BogdanAIP", repo: "rakazo", repository_full_name: "BogdanAIP/AIHOT" }],
    ["create_pull_request", { owner: "BogdanAIP", repo: "rakazo", head_repo: "BogdanAIP/AIHOT" }],
    ["issue_write", { owner: "BogdanAIP", repo: "rakazo", repositories: ["BogdanAIP/AIHOT"] }],
    [
      "issue_write",
      { owner: "BogdanAIP", repo: "rakazo", parent_owner: "BogdanAIP", parent_repo: "AIHOT" },
    ],
    ["issue_write", { owner: "BogdanAIP", repo: "rakazo", parent_owner: "BogdanAIP" }],
    [
      "custom_properties_write",
      { owner: "BogdanAIP", repo: "rakazo", level: "organization", org: "BogdanAIP" },
    ],
    [
      "create_repository_ruleset",
      { owner: "BogdanAIP", repo: "rakazo", level: "enterprise", enterprise: "other" },
    ],
    ["create_pull_request", { owner: "BogdanAIP", repo: "rakazo", head: "AnotherOwner:branch" }],
    ["sub_issue_write", { owner: "BogdanAIP", repo: "rakazo", issue_number: 1, sub_issue_id: 50 }],
    [
      "discussion_comment_write",
      { owner: "BogdanAIP", repo: "rakazo", method: "update", commentNodeID: "foreign" },
    ],
    [
      "pull_request_review_write",
      { owner: "BogdanAIP", repo: "rakazo", method: "resolve_thread", threadId: "foreign" },
    ],
    ["add_reply_to_pull_request_comment", { owner: "BogdanAIP", repo: "rakazo", commentId: 100 }],
    ["update_issue_comment", { owner: "BogdanAIP", repo: "rakazo", comment_id: 100 }],
    ["add_issue_comment", { owner: "BogdanAIP", repo: "rakazo", issue_number: 1, comment_id: 100 }],
    [
      "custom_properties_write",
      { owner: "BogdanAIP", repo: "rakazo", level: "repository", org: "BogdanAIP" },
    ],
    [
      "create_repository_ruleset",
      { owner: "BogdanAIP", repo: "rakazo", level: "repository", enterprise: "elsewhere" },
    ],
  ])("fails closed for unsupported or ambiguous targets: %s", (name, args) => {
    expect(() => githubWriteTarget(name, args)).toThrow();
  });

  it("authorizes only the selected project and matching MCP server", async () => {
    const { prisma, projectLookup, resourceLookup } = fixture();
    await expect(
      assertGithubProjectWrite(prisma, context, "github-server", "push_files", {
        owner: "BogdanAIP",
        repo: "rakazo",
      }),
    ).resolves.toBe("bogdanaip/rakazo");
    expect(projectLookup).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        spaceId: "space-1",
        userId: "user-1",
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(resourceLookup).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        spaceId: "space-1",
        userId: "user-1",
        kind: "github.repo",
      },
      select: { ref: true, metadata: true },
    });
  });

  it("rejects a different repository, a different server, or an ungranted resource", async () => {
    const { prisma } = fixture();
    await expect(
      assertGithubProjectWrite(prisma, context, "github-server", "push_files", {
        owner: "BogdanAIP",
        repo: "AIHOT",
      }),
    ).rejects.toThrow("no autonomous_write grant");
    await expect(
      assertGithubProjectWrite(prisma, context, "other-server", "push_files", {
        owner: "BogdanAIP",
        repo: "rakazo",
      }),
    ).rejects.toThrow("no autonomous_write grant");
    const ungranted = fixture([{ ref: "BogdanAIP/rakazo", metadata: {} }]);
    await expect(
      assertGithubProjectWrite(ungranted.prisma, context, "github-server", "push_files", {
        owner: "BogdanAIP",
        repo: "rakazo",
      }),
    ).rejects.toThrow("no autonomous_write grant");
  });

  it("denies missing, inaccessible and archived project contexts", async () => {
    const f = fixture();
    await expect(
      assertGithubProjectWrite(
        f.prisma,
        { ...context, projectId: undefined },
        "github-server",
        "push_files",
        {
          owner: "BogdanAIP",
          repo: "rakazo",
        },
      ),
    ).rejects.toThrow("projectId is required");
    expect(f.projectLookup).not.toHaveBeenCalled();
    const absent = fixture([GRANT], null);
    await expect(
      assertGithubProjectWrite(absent.prisma, context, "github-server", "delete_file", {
        owner: "BogdanAIP",
        repo: "rakazo",
      }),
    ).rejects.toThrow("not accessible");
    expect(absent.resourceLookup).not.toHaveBeenCalled();
  });
});
