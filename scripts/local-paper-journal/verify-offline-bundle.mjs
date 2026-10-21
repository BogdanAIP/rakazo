/**
 * Strict offline PAPER reviewer provenance check.
 * Only esbuild's source-file label comments are path-normalized. The original
 * artifact is verified against its immutable SHA-256 and all executable bytes
 * must match the independent rebuild. No live PAPER state is accessed.
 *
 * Usage: node verify-offline-bundle.mjs SOURCE_REPO TARGET_REPO
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

function assertProvenance(ok, message) {
  if (!ok) throw new Error("PAPER provenance: " + message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// esbuild inserts stand-alone non-executable comments with absolute/relative
// source-file paths. Windows, Linux and the historical authoring worktree have
// different path roots. Keep each package name, version, and relative filename;
// remove ONLY the path prefix before the canonical module-root segment.
// This cannot remove JavaScript statements, license banners or inline comments.
const esbuildSourceBanner =
  /^(\/\/ )[^\s]*(node_modules\/\.pnpm\/|packages\/[a-z-]+\/src\/|scripts\/paper-offline-review\.entry\.ts)([^\r\n]*)$/gm;

function canonicalizeSourceLabels(buffer) {
  const input = buffer.toString("utf8");
  let count = 0;
  const content = input.replace(esbuildSourceBanner, (_whole, comment, root, rest) => {
    count += 1;
    return comment + root + rest;
  });
  return { content, count };
}

const [sourceArg, targetArg] = process.argv.slice(2);
assertProvenance(sourceArg && targetArg, "two explicit repository paths required");
const source = path.resolve(sourceArg);
const target = path.resolve(targetArg);
assertProvenance(path.basename(source) === SOURCE_DIR_NAME, "unexpected source directory");
assertProvenance(
  path.dirname(source) === path.dirname(target),
  "source and target must be siblings",
);
assertProvenance(source !== target, "source and target must differ");

const revision = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
  timeout: 10000,
  shell: false,
  windowsHide: true,
});
assertProvenance(
  revision.status === 0 && revision.stdout.trim() === SOURCE_SHA,
  "unpinned source SHA",
);

const esbuild = path.join(
  target,
  "node_modules",
  ".pnpm",
  "esbuild@" + ESBUILD_VERSION,
  "node_modules",
  "esbuild",
  "bin",
  "esbuild",
);
const entry = path.join(source, "scripts", "paper-offline-review.entry.ts");
const alias = path.join(source, "packages", "contracts", "src", "index.ts");
const committed = path.join(target, "scripts", "local-paper-journal", "offline-gap-runtime.mjs");
const rebuilt = path.join(
  target,
  "scripts",
  "local-paper-journal",
  "offline-gap-runtime.verify.mjs",
);
for (const filename of [esbuild, entry, alias, committed]) {
  assertProvenance(
    existsSync(filename) && statSync(filename).isFile(),
    "required file missing: " + filename,
  );
}
assertProvenance(!existsSync(rebuilt), "temporary output already exists");

try {
  const result = spawnSync(
    process.execPath,
    [
      esbuild,
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      "--outfile=" + rebuilt,
      "--alias:@rakazo/contracts=" + alias,
    ],
    { encoding: "utf8", timeout: 60000, shell: false, windowsHide: true },
  );
  assertProvenance(
    result.status === 0 && !result.error,
    "esbuild failed: " + (result.stderr || result.error || "unknown"),
  );

  const expected = readFileSync(committed);
  const actual = readFileSync(rebuilt);
  assertProvenance(expected.length === BUNDLE_BYTES, "committed artifact length changed");
  assertProvenance(sha256(expected) === BUNDLE_SHA256, "committed artifact SHA-256 changed");

  const canonicalExpected = canonicalizeSourceLabels(expected);
  const canonicalActual = canonicalizeSourceLabels(actual);
  assertProvenance(
    canonicalExpected.count > 0 && canonicalExpected.count === canonicalActual.count,
    "esbuild source-label set differs",
  );
  if (canonicalExpected.content !== canonicalActual.content) {
    const a = canonicalExpected.content;
    const b = canonicalActual.content;
    let offset = 0;
    while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset += 1;
    console.error(
      JSON.stringify({
        expectedBytes: expected.length,
        rebuiltBytes: actual.length,
        expectedSha256: sha256(expected),
        rebuiltSha256: sha256(actual),
        sourceLabels: canonicalExpected.count,
        firstExecutableMismatchAt: offset,
        expectedExcerpt: a.slice(Math.max(0, offset - 50), offset + 120),
        rebuiltExcerpt: b.slice(Math.max(0, offset - 50), offset + 120),
      }),
    );
  }
  assertProvenance(
    canonicalExpected.content === canonicalActual.content,
    "generated executable content differs after source-label-only canonicalization",
  );
  console.log("PASS PAPER_OFFLINE_BUNDLE_SOURCE_SHA=" + SOURCE_SHA);
  console.log("PASS PAPER_OFFLINE_BUNDLE_COMMITTED_SHA256=" + BUNDLE_SHA256);
  console.log("PASS PAPER_OFFLINE_BUNDLE_EXECUTABLE_BYTES=" + actual.length);
  console.log("PASS PAPER_OFFLINE_BUNDLE_ESBUILD_LABEL_COUNT=" + canonicalExpected.count);
} finally {
  if (existsSync(rebuilt)) rmSync(rebuilt, { force: true });
}
