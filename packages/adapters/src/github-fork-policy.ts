import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { GithubProjectScopeDenied } from "./github-project-policy.js";

type Records = Pick<PrismaClient, "project" | "projectResource">;
type JsonRow = { kind: string; ref: string; metadata: unknown };
const REPO = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;
const OWNER = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

function canonical(value: unknown): string | null {
  return typeof value === "string" && REPO.test(value.trim()) ? value.trim().toLowerCase() : null;
}
function metadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function granted(row: JsonRow, serverId: string, access: string): boolean {
  const m = metadata(row.metadata);
  return m.githubAccess === access && m.githubMcpServerId === serverId;
}
async function resources(db: Records, ctx: AdapterContext): Promise<JsonRow[]> {
  if (!ctx.projectId)
    throw new GithubProjectScopeDenied("Project context is required for GitHub mutations.");
  const project = await db.project.findFirst({
    where: { id: ctx.projectId, spaceId: ctx.spaceId, userId: ctx.userId, archivedAt: null },
    select: { id: true },
  });
  if (!project) throw new GithubProjectScopeDenied("GitHub project is inaccessible or archived.");
  return db.projectResource.findMany({
    where: { projectId: project.id, spaceId: ctx.spaceId, userId: ctx.userId },
    select: { kind: true, ref: true, metadata: true },
  });
}
function sourceRepo(args: Record<string, unknown>): string {
  const target = canonical(
    typeof args.owner === "string" && typeof args.repo === "string"
      ? `${args.owner}/${args.repo}`
      : null,
  );
  if (!target) throw new GithubProjectScopeDenied("Fork needs a concrete source owner/repo.");
  return target;
}
/** Fail closed if the GitHub MCP identity response is not an authenticated login. */
export function githubAuthenticatedLogin(result: unknown): string {
  const outer = metadata(result);
  if (outer.isError === true) throw new GithubProjectScopeDenied("GitHub identity lookup failed.");
  let payload = metadata(outer.structuredContent);
  if (!payload.login && Array.isArray(outer.content)) {
    const entry = outer.content.find((item: unknown) => metadata(item).type === "text");
    const json = metadata(entry).text;
    if (typeof json === "string") {
      try {
        payload = metadata(JSON.parse(json));
      } catch {
        /* invalid response */
      }
    }
  }
  const login = payload.login;
  if (typeof login !== "string" || !OWNER.test(login)) {
    throw new GithubProjectScopeDenied("Cannot verify the authenticated GitHub login.");
  }
  return login.toLowerCase();
}
/** The authenticated user login is obtained from the SAME GitHub MCP session's get_me tool. */
export async function authorizeGithubFork(
  db: Records,
  ctx: AdapterContext,
  serverId: string,
  args: Record<string, unknown>,
  authenticatedLogin: string,
): Promise<{ source: string; destination: string }> {
  const source = sourceRepo(args);
  const organization = args.organization;
  if (
    organization !== undefined &&
    (typeof organization !== "string" || !OWNER.test(organization))
  ) {
    throw new GithubProjectScopeDenied("Invalid fork destination organization.");
  }
  const destination = organization ?? authenticatedLogin;
  if (typeof destination !== "string" || !OWNER.test(destination)) {
    throw new GithubProjectScopeDenied("Authenticated fork destination is unavailable.");
  }
  const rows = await resources(db, ctx);
  if (
    !rows.some(
      (r) =>
        r.kind === "github.fork.destination" &&
        r.ref.toLowerCase() === destination.toLowerCase() &&
        granted(r, serverId, "allow_fork"),
    )
  )
    throw new GithubProjectScopeDenied("Project has no allow_fork grant for this destination.");
  return { source, destination: destination.toLowerCase() };
}
/** Only an actual GitHub repository response with a matching parent may create a grant. */
export function verifiedFork(result: unknown, source: string, destination: string): string | null {
  const outer = metadata(result);
  if (outer.isError === true) return null;
  let repository = metadata(outer.structuredContent);
  if (!repository.full_name && Array.isArray(outer.content)) {
    const text = outer.content.find((v: unknown) => metadata(v).type === "text");
    const payload = metadata(text).text;
    if (typeof payload === "string") {
      try {
        repository = metadata(JSON.parse(payload));
      } catch {
        return null;
      }
    }
  }
  if (!repository.full_name && outer.full_name) repository = outer;
  const full = canonical(repository.full_name);
  const parent = canonical(metadata(repository.parent).full_name);
  const owner = metadata(repository.owner).login;
  if (
    repository.fork !== true ||
    !full ||
    parent !== source ||
    typeof owner !== "string" ||
    owner.toLowerCase() !== destination ||
    !full.startsWith(`${destination}/`)
  )
    return null;
  return full;
}
export async function registerGithubFork(
  db: Records,
  ctx: AdapterContext,
  serverId: string,
  fork: { source: string; destination: string },
  result: unknown,
): Promise<boolean> {
  const name = verifiedFork(result, fork.source, fork.destination);
  if (!name || !ctx.projectId) return false;
  const rows = await resources(db, ctx);
  if (
    !rows.some(
      (r) =>
        r.kind === "github.fork.destination" &&
        r.ref.toLowerCase() === fork.destination &&
        granted(r, serverId, "allow_fork"),
    )
  )
    return false;
  // Never overwrite a pre-existing resource/grant; manual review remains possible.
  if (rows.some((r) => r.kind === "github.repo" && canonical(r.ref) === name)) return false;
  try {
    await db.projectResource.create({
      data: {
        projectId: ctx.projectId,
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        kind: "github.repo",
        ref: name,
        label: name,
        metadata: {
          githubAccess: "autonomous_write",
          githubMcpServerId: serverId,
          forkOf: fork.source,
          verifiedFork: true,
        },
      },
    });
    await db.projectResource.create({
      data: {
        projectId: ctx.projectId,
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        kind: "github.pr.upstream",
        ref: `${fork.source}#${name}`,
        label: `PR: ${name} -> ${fork.source}`,
        metadata: {
          githubAccess: "contribute_via_pr",
          githubMcpServerId: serverId,
          upstream: fork.source,
          forkRef: name,
          verifiedFork: true,
        },
      },
    });
  } catch {
    return false;
  } // A concurrent insert must never broaden a different grant.
  return true;
}
/** Contribute via PR: write ONLY to GitHub PR metadata on upstream, code stays in a verified fork. */
export async function assertGithubContribution(
  db: Records,
  ctx: AdapterContext,
  serverId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const upstream = sourceRepo(args);
  const head = args.head;
  if (typeof head !== "string" || head.split(":").length !== 2) {
    throw new GithubProjectScopeDenied(
      "Cross-repository PR requires a qualified fork owner:branch.",
    );
  }
  const [owner, branch] = head.split(":");
  if (
    !owner ||
    !OWNER.test(owner) ||
    !branch ||
    /[\s:\\]/.test(branch) ||
    args.head_repo !== undefined ||
    typeof args.base !== "string" ||
    !args.base.trim()
  ) {
    throw new GithubProjectScopeDenied("Invalid or ambiguous fork PR selectors.");
  }
  const rows = await resources(db, ctx);
  const authorized = rows.some((candidate) => {
    const forkInfo = metadata(candidate.metadata);
    if (
      candidate.kind !== "github.repo" ||
      !canonical(candidate.ref)?.startsWith(`${owner.toLowerCase()}/`) ||
      !granted(candidate, serverId, "autonomous_write") ||
      forkInfo.verifiedFork !== true ||
      canonical(forkInfo.forkOf) !== upstream
    )
      return false;
    return rows.some((upstreamRow) => {
      const pr = metadata(upstreamRow.metadata);
      return (
        upstreamRow.kind === "github.pr.upstream" &&
        granted(upstreamRow, serverId, "contribute_via_pr") &&
        canonical(pr.upstream) === upstream &&
        canonical(pr.forkRef) === canonical(candidate.ref) &&
        pr.verifiedFork === true
      );
    });
  });
  if (!authorized) {
    throw new GithubProjectScopeDenied(
      "Contribution requires upstream PR grant and verified writable fork.",
    );
  }
  return upstream;
}
