export type RakazoCaller = (
  procedure: string,
  input?: Record<string, unknown>,
) => Promise<unknown>;

export type ProjectWorktreeAction = "list" | "verify" | "ensure";

export type ProjectWorktreeInput = {
  action: ProjectWorktreeAction;
  projectId: string;
  computerBotId: string;
  repository: string;
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  baseRef?: string;
  role?: string;
};

type WorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected Rakazo " + label + " response");
  }
  return value as Record<string, unknown>;
}

function objects(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Unexpected Rakazo " + label + " response");
  return value.map((item) => object(item, label));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function canonicalPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function githubRepoFromRemote(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, "");
  const https = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) return https[1] + "/" + https[2];
  const scp = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (scp) return scp[1] + "/" + scp[2];
  const ssh = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (ssh) return ssh[1] + "/" + ssh[2];
  return null;
}

export function parseGitWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const result: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) result.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice("worktree ".length), detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") current.detached = true;
  }
  if (current) result.push(current);
  return result;
}

async function git(
  call: RakazoCaller,
  botId: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const value = object(
    await call("computer/exec", {
      botId,
      argv: ["git", ...args],
      timeoutMs: 18_000,
    }),
    "computer/exec",
  );
  return {
    stdout: str(value.stdout),
    stderr: str(value.stderr),
    code: typeof value.code === "number" ? value.code : -1,
  };
}

function assertOk(result: { stdout: string; stderr: string; code: number }, operation: string): void {
  if (result.code === 0) return;
  const detail = (result.stderr || result.stdout).trim().slice(0, 2_000);
  throw new Error(operation + " failed" + (detail ? ": " + detail : ""));
}

function requireProjectRepository(
  projectContext: Record<string, unknown>,
  repository: string,
): Record<string, unknown>[] {
  const resources = objects(projectContext.resources, "projects/context resources");
  const exact = resources.some(
    (resource) => resource.kind === "github.repo" && str(resource.ref) === repository,
  );
  if (!exact) {
    throw new Error("Project has no exact github.repo resource for " + repository);
  }
  return resources;
}

async function verifyOrigin(
  call: RakazoCaller,
  input: ProjectWorktreeInput,
): Promise<string> {
  const remote = await git(call, input.computerBotId, [
    "-C",
    input.repoPath,
    "remote",
    "get-url",
    "origin",
  ]);
  assertOk(remote, "git remote get-url origin");
  const actualRepo = githubRepoFromRemote(remote.stdout);
  if (!actualRepo || actualRepo.toLowerCase() !== input.repository.toLowerCase()) {
    throw new Error(
      "Local origin does not match project repository: expected " +
        input.repository +
        ", got " +
        remote.stdout.trim(),
    );
  }
  return remote.stdout.trim();
}

async function listWorktrees(
  call: RakazoCaller,
  input: ProjectWorktreeInput,
): Promise<WorktreeEntry[]> {
  const listed = await git(call, input.computerBotId, [
    "-C",
    input.repoPath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  assertOk(listed, "git worktree list");
  return parseGitWorktreePorcelain(listed.stdout);
}

function requireWorktreePath(input: ProjectWorktreeInput): string {
  const value = input.worktreePath?.trim();
  if (!value) throw new Error("worktreePath is required for verify/ensure");
  if (canonicalPath(value) === canonicalPath(input.repoPath)) {
    throw new Error("worktreePath must differ from repoPath");
  }
  return value;
}

async function verifyWorktree(
  call: RakazoCaller,
  input: ProjectWorktreeInput,
  expectedPath: string,
  expectedBranch?: string,
): Promise<{ path: string; branch: string; head: string }> {
  const top = await git(call, input.computerBotId, [
    "-C",
    expectedPath,
    "rev-parse",
    "--show-toplevel",
  ]);
  assertOk(top, "git rev-parse --show-toplevel");
  if (canonicalPath(top.stdout) !== canonicalPath(expectedPath)) {
    throw new Error("Verified worktree root differs from requested path");
  }

  const branchResult = await git(call, input.computerBotId, [
    "-C",
    expectedPath,
    "branch",
    "--show-current",
  ]);
  assertOk(branchResult, "git branch --show-current");
  const branch = branchResult.stdout.trim();
  if (!branch) throw new Error("Worktree is detached; a branch checkout is required");
  if (expectedBranch && branch !== expectedBranch) {
    throw new Error("Worktree branch mismatch: expected " + expectedBranch + ", got " + branch);
  }

  const headResult = await git(call, input.computerBotId, ["-C", expectedPath, "rev-parse", "HEAD"]);
  assertOk(headResult, "git rev-parse HEAD");
  return { path: expectedPath, branch, head: headResult.stdout.trim() };
}

export async function manageProjectWorktree(
  call: RakazoCaller,
  input: ProjectWorktreeInput,
): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error("repository must be exact owner/name");
  }
  if (!input.repoPath.trim()) throw new Error("repoPath is required");

  const projectContext = object(
    await call("projects/context", { projectId: input.projectId }),
    "projects/context",
  );
  const resources = requireProjectRepository(projectContext, input.repository);

  await call("computer/takeover", { botId: input.computerBotId });
  const origin = await verifyOrigin(call, input);
  let worktrees = await listWorktrees(call, input);

  if (input.action === "list") {
    return {
      repository: input.repository,
      repoPath: input.repoPath,
      origin,
      worktrees,
      registeredWorktrees: resources.filter((resource) =>
        str(resource.kind).endsWith(".worktree"),
      ),
    };
  }

  const worktreePath = requireWorktreePath(input);
  const existing = worktrees.find(
    (entry) => canonicalPath(entry.path) === canonicalPath(worktreePath),
  );

  if (input.action === "verify") {
    if (!existing) throw new Error("Requested worktree is not registered by git");
    const verified = await verifyWorktree(call, input, worktreePath, input.branch);
    return { repository: input.repository, origin, worktree: verified };
  }

  const branch = input.branch?.trim();
  if (!branch) throw new Error("branch is required for ensure");

  const branchFormat = await git(call, input.computerBotId, ["check-ref-format", "--branch", branch]);
  assertOk(branchFormat, "git check-ref-format --branch");

  if (existing) {
    if (existing.detached || existing.branch !== branch) {
      throw new Error(
        "Existing worktree path is attached to a different or detached branch; refusing to modify it",
      );
    }
  } else {
    const localBranch = await git(call, input.computerBotId, [
      "-C",
      input.repoPath,
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/" + branch,
    ]);

    let addArgs: string[];
    if (localBranch.code === 0) {
      addArgs = ["-C", input.repoPath, "worktree", "add", worktreePath, branch];
    } else {
      if (localBranch.code !== 1) {
        assertOk(localBranch, "git show-ref local branch");
      }
      const baseRef = input.baseRef?.trim();
      if (!baseRef) throw new Error("baseRef is required when the local branch does not exist");
      if (baseRef.startsWith("-")) throw new Error("baseRef must not start with '-'");
      const base = await git(call, input.computerBotId, [
        "-C",
        input.repoPath,
        "rev-parse",
        "--verify",
        baseRef + "^{commit}",
      ]);
      assertOk(base, "git rev-parse baseRef");
      addArgs = ["-C", input.repoPath, "worktree", "add", "-b", branch, worktreePath, baseRef];
    }

    const added = await git(call, input.computerBotId, addArgs);
    assertOk(added, "git worktree add");
    worktrees = await listWorktrees(call, input);
    if (
      !worktrees.some(
        (entry) =>
          canonicalPath(entry.path) === canonicalPath(worktreePath) &&
          !entry.detached &&
          entry.branch === branch,
      )
    ) {
      throw new Error("New worktree did not appear with the expected branch");
    }
  }

  const verified = await verifyWorktree(call, input, worktreePath, branch);
  const resource = await call("projects/resources/upsert", {
    projectId: input.projectId,
    kind: "workspace.worktree",
    ref: verified.path,
    label: branch,
    metadata: {
      repo: input.repository,
      branch: verified.branch,
      computerBotId: input.computerBotId,
      repoPath: input.repoPath,
      role: input.role?.trim() || "development",
      head: verified.head,
      ...(input.baseRef?.trim() ? { baseRef: input.baseRef.trim() } : {}),
    },
  });

  return {
    repository: input.repository,
    origin,
    worktree: verified,
    resource,
    created: !existing,
  };
}
