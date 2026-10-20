import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const BOT_ID = /^[a-zA-Z0-9_-]{1,100}$/u;
const MAX_ROOTS_PER_BOT = 8;
const MAX_ROOT_LENGTH = 4096;

/**
 * Host-owned, per-bot allowlist. A bot cannot add entries through computer/exec.
 * Example: {"bot-id":["C:\\Users\\owner\\trusted-repository"]}
 *
 * This grants only process working-directory selection. files.read/files.list
 * and file mutation retain their separate, workspace-only restrictions.
 */
export type TrustedExecRoots = Readonly<Record<string, readonly string[]>>;

export function parseTrustedExecRoots(raw?: string): TrustedExecRoots {
  const roots: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  if (!raw?.trim()) return roots;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid RAKAZO_WINDOWS_TRUSTED_EXEC_ROOTS_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Trusted execution roots must be a per-bot JSON object");
  }
  for (const [botId, value] of Object.entries(parsed)) {
    if (!BOT_ID.test(botId) || !Array.isArray(value) || value.length > MAX_ROOTS_PER_BOT) {
      throw new Error("Invalid trusted execution roots mapping");
    }
    const entries: string[] = [];
    for (const entry of value as unknown[]) {
      if (
        typeof entry !== "string" ||
        !entry.trim() ||
        entry.length > MAX_ROOT_LENGTH ||
        entry.includes("\0") ||
        !path.isAbsolute(entry) ||
        entry.startsWith("\\\\") ||
        entry.split(/[\\/]/u).includes("..")
      ) {
        throw new Error("Trusted execution roots must be absolute local directories");
      }
      const canonical = path.resolve(entry);
      if (canonical === path.parse(canonical).root) {
        throw new Error("A drive or filesystem root cannot be trusted for execution");
      }
      entries.push(canonical);
    }
    roots[botId] = entries;
  }
  return roots;
}

function within(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) return null;
  return relative;
}

/**
 * Fail closed: the configured root and each selected subdirectory must be real
 * directories rather than symlinks/junctions. Also verify resolved containment.
 * No changes to filesystem visibility or inherited process permissions are made.
 */
export async function resolveTrustedExecDirectory(
  botId: string,
  requested: string,
  trustedRoots: TrustedExecRoots,
): Promise<string> {
  if (
    !BOT_ID.test(botId) ||
    !path.isAbsolute(requested) ||
    requested.includes("\0") ||
    requested.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Invalid trusted Windows process working directory");
  }

  for (const root of trustedRoots[botId] ?? []) {
    const relative = within(root, path.resolve(requested));
    if (relative === null) continue;
    let current = root;
    for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Trusted Windows process directory contains a link or non-directory");
      }
    }
    const resolvedRoot = await realpath(root);
    const resolvedTarget = await realpath(current);
    if (within(resolvedRoot, resolvedTarget) === null) {
      throw new Error("Trusted Windows process directory escapes its registered root");
    }
    return resolvedTarget;
  }

  throw new Error("Windows process cwd is outside the registered trusted directories for this bot");
}
