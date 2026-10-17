import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/** Only repository-confined writes are eligible. New and account-wide tools fail closed. */
const REPOSITORY_WRITE_TOOLS = new Set([
  "actions_run_trigger",
  "add_comment_to_pending_review",
  "add_issue_comment",
  "add_reply_to_pull_request_comment",
  "assign_copilot_to_issue",
  "assign_copilot_to_issue_with_intent",
  "create_branch",
  "create_or_update_file",
  "create_pull_request",
  "create_repository_ruleset",
  "custom_properties_write",
  "delete_file",
  "discussion_comment_write",
  "issue_write",
  "label_write",
  "manage_repository_notification_subscription",
  "merge_pull_request",
  "pull_request_review_write",
  "push_files",
  "request_copilot_review",
  "star_repository",
  "unstar_repository",
  "update_issue_comment",
  "update_pull_request",
  "update_pull_request_branch",
]);

export class GithubProjectScopeDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubProjectScopeDenied";
  }
}

const REPO_PATTERN = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return REPO_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Reject missing or conflicting targets, and secondary cross-repo selectors. */
export function githubWriteTarget(toolName: string, args: Record<string, unknown>): string {
  if (!REPOSITORY_WRITE_TOOLS.has(toolName)) {
    throw new GithubProjectScopeDenied("This GitHub tool is not confined to one repository.");
  }
  const owner = args.owner;
  const repo = args.repo;
  const pair =
    typeof owner === "string" && typeof repo === "string"
      ? canonicalRepo(`${owner}/${repo}`)
      : null;
  const full =
    args.repository_full_name === undefined ? null : canonicalRepo(args.repository_full_name);
  if (
    ((owner !== undefined || repo !== undefined) && !pair) ||
    (args.repository_full_name !== undefined && !full) ||
    (pair && full && pair !== full)
  ) {
    throw new GithubProjectScopeDenied("Ambiguous or malformed GitHub repository target.");
  }
  const target = pair ?? full;
  if (!target) {
    throw new GithubProjectScopeDenied("A concrete owner/repo is required for GitHub writes.");
  }
  if (args.head_repo !== undefined && canonicalRepo(args.head_repo) !== target) {
    throw new GithubProjectScopeDenied("Cross-repository head_repo is not authorized.");
  }
  if (
    args.repository_names !== undefined ||
    args.repositories !== undefined ||
    args.organization !== undefined
  ) {
    throw new GithubProjectScopeDenied(
      "Bulk or cross-repository GitHub operation is not authorized.",
    );
  }
  if (
    (toolName === "custom_properties_write" || toolName === "create_repository_ruleset") &&
    args.level !== "repository"
  ) {
    throw new GithubProjectScopeDenied("Only repository-level GitHub changes are authorized.");
  }
  if (
    toolName === "issue_write" &&
    (args.parent_owner !== undefined || args.parent_repo !== undefined)
  ) {
    const parent =
      typeof args.parent_owner === "string" && typeof args.parent_repo === "string"
        ? canonicalRepo(`${args.parent_owner}/${args.parent_repo}`)
        : null;
    if (parent !== target) {
      throw new GithubProjectScopeDenied("Cross-repository parent issue is not authorized.");
    }
  }
  // A qualified PR head can select a fork outside the authorized repository.
  if (
    toolName === "create_pull_request" &&
    (typeof args.head !== "string" || args.head.includes(":"))
  ) {
    throw new GithubProjectScopeDenied(
      "A pull request head must be an unqualified branch in the authorized repository.",
    );
  }
  // Opaque node IDs cannot be attributed to the target repository from arguments alone.
  if (
    toolName === "discussion_comment_write" &&
    (args.method !== "add" || args.commentNodeID !== undefined)
  ) {
    throw new GithubProjectScopeDenied(
      "Only repository-scoped new discussion comments are authorized.",
    );
  }
  if (
    toolName === "pull_request_review_write" &&
    (args.threadId !== undefined ||
      !["create", "submit_pending", "delete_pending"].includes(String(args.method)))
  ) {
    throw new GithubProjectScopeDenied(
      "Review thread node mutations require separate repository verification.",
    );
  }
  if (
    toolName === "add_reply_to_pull_request_comment" ||
    toolName === "update_issue_comment" ||
    (toolName === "add_issue_comment" && args.comment_id !== undefined)
  ) {
    throw new GithubProjectScopeDenied(
      "Opaque cross-repository comment IDs require separate verification.",
    );
  }
  if (
    (toolName === "custom_properties_write" || toolName === "create_repository_ruleset") &&
    (args.org !== undefined || args.enterprise !== undefined)
  ) {
    throw new GithubProjectScopeDenied(
      "An organization or enterprise selector is not repository-scoped.",
    );
  }
  return target;
}

/** Execute at the final backend boundary, before the authoritative MCP call. */
export async function assertGithubProjectWrite(
  prisma: Pick<PrismaClient, "project" | "projectResource">,
  context: AdapterContext,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const target = githubWriteTarget(toolName, args);
  if (!context.projectId) {
    throw new GithubProjectScopeDenied("A projectId is required for autonomous GitHub writes.");
  }
  const project = await prisma.project.findFirst({
    where: {
      id: context.projectId,
      spaceId: context.spaceId,
      userId: context.userId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!project) {
    throw new GithubProjectScopeDenied("The project is not accessible or has been archived.");
  }
  const resources = await prisma.projectResource.findMany({
    where: {
      projectId: project.id,
      spaceId: context.spaceId,
      userId: context.userId,
      kind: "github.repo",
    },
    select: { ref: true, metadata: true },
  });
  const granted = resources.some((resource) => {
    const metadata =
      resource.metadata &&
      typeof resource.metadata === "object" &&
      !Array.isArray(resource.metadata)
        ? resource.metadata
        : {};
    return (
      canonicalRepo(resource.ref) === target &&
      "githubAccess" in metadata &&
      metadata.githubAccess === "autonomous_write" &&
      "githubMcpServerId" in metadata &&
      metadata.githubMcpServerId === serverId
    );
  });
  if (!granted) {
    throw new GithubProjectScopeDenied(
      "The project has no autonomous_write grant for this GitHub repository and MCP server.",
    );
  }
  return target;
}
