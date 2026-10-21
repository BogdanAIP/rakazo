/**
 * PR81 PAPER offline reviewer provenance check.
 * Rebuilds the committed artifact from an exact, independent source commit.
 * Never reads the live PAPER config, credentials, ledger, or service ports.
 *
 * Usage: node scripts/local-paper-journal/verify-offline-bundle.mjs SOURCE_REPO TARGET_REPO
 * Both repos must be sibling directories; SOURCE_REPO basename must match the
 * original esbuild source path to make source comments reproducible.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const SOURCE_SHA = "368e88e86ba2f2edc5110ad0046b0b48417be239";
const BUNDLE_SHA256 = "886b8e020c15cbd9596c883558cbb63781d4168f09fa82f70e0413450840f12e";
const BUNDLE_BYTES = 950470;
const SOURCE_DIR_NAME = "rakazo-paper-offline-core-20261019";
const ESBUILD_VERSION = "0.28.2";

function check(condition, message) {
  if (!condition) throw new Error("PAPER provenance: " + message);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const [sourceArg, targetArg] = process.argv.slice(2);
check(sourceArg && targetArg, "two explicitly checked-out repository paths required");
const source = path.resolve(sourceArg);
const target = path.resolve(targetArg);
check(path.basename(source) === SOURCE_DIR_NAME, "canonical source directory name changed");
check(path.dirname(source) === path.dirname(target), "source and target must be sibling worktrees");
check(source !== target, "source and target cannot coincide");

const git = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8", timeout: 10000, shell: false, windowsHide: true,
});
check(git.status === 0 && git.stdout.trim() === SOURCE_SHA, "source Git commit is not the pinned SHA");

const esbuild = path.join(
  target, "node_modules", ".pnpm", "esbuild@" + ESBUILD_VERSION,
  "node_modules", "esbuild", "bin", "esbuild",
);
const entry = path.join(source, "scripts", "paper-offline-review.entry.ts");
const alias = path.join(source, "packages", "contracts", "src", "index.ts");
const committed = path.join(target, "scripts", "local-paper-journal", "offline-gap-runtime.mjs");
const rebuilt = path.join(target, "scripts", "local-paper-journal", "offline-gap-runtime.verify.mjs");
for (const p of [esbuild, entry, alias, committed]) check(existsSync(p) && statSync(p).isFile(), "missing required file: " + p);
check(!existsSync(rebuilt), "verification output already exists (refusing overwrite)");

try {
  const result = spawnSync(
    process.execPath,
    [
      esbuild, entry,
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--outfile=" + rebuilt,
      "--alias:@rakazo/contracts=" + alias,
    ],
    { encoding: "utf8", timeout: 60000, shell: false, windowsHide: true },
  );
  check(result.status === 0 && !result.error, "esbuild failed: " + (result.stderr || result.error || "unknown"));
  const expected = readFileSync(committed);
  const actual = readFileSync(rebuilt);
  check(expected.length === BUNDLE_BYTES, "committed bundle size changed");
  check(actual.length === BUNDLE_BYTES, "recompiled bundle size differs");
  check(sha256(expected) === BUNDLE_SHA256, "committed bundle hash changed");
  check(sha256(actual) === BUNDLE_SHA256, "recompiled bundle hash differs");
  check(expected.equals(actual), "recompiled bundle not byte-for-byte equal");
  console.log("PASS PAPER_OFFLINE_BUNDLE_PINNED_SHA=" + SOURCE_SHA);
  console.log("PASS PAPER_OFFLINE_BUNDLE_BYTES=" + actual.length);
  console.log("PASS PAPER_OFFLINE_BUNDLE_SHA256=" + sha256(actual));
} finally {
  if (existsSync(rebuilt)) rmSync(rebuilt, { force: true });
}
