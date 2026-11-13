import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = path.dirname(fileURLToPath(import.meta.url));
const runtime =
  process.env.RAKAZO_PAPER_RUNTIME_CONFIG ??
  path.join(
    os.homedir(),
    "RakazoRuntime",
    "trading-live-data-20261011",
    "paper-runtime-config.json",
  );
const cfg = JSON.parse(await readFile(runtime, "utf8"));
if (!cfg?.repo || !path.isAbsolute(cfg.repo)) throw new Error("Unregistered PAPER runtime");
const sourceRepo = process.env.RAKAZO_GRACEFUL_SOURCE_REPO ?? cfg.repo;
if (!path.isAbsolute(sourceRepo)) {
  throw new Error("Canonical graceful worker source path must be absolute");
}
const input = path.join(sourceRepo, "packages", "adapters", "src", "paper-graceful-stop.ts");
if (!(await stat(input)).isFile()) throw new Error("Canonical graceful stop source is missing");
const folders = await readdir(path.join(cfg.repo, "node_modules", ".pnpm"));
const candidates = folders.filter((name) => /^esbuild@\d/.test(name));
if (candidates.length !== 1) throw new Error("Ambiguous esbuild toolchain");
const binary = path.join(
  cfg.repo,
  "node_modules",
  ".pnpm",
  candidates[0],
  "node_modules",
  "esbuild",
  "bin",
  "esbuild",
);
const dest = path.join(home, "paper-graceful-stop-runtime.mjs");
const result = spawnSync(
  process.execPath,
  [
    binary,
    input,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--outfile=" + dest,
  ],
  { stdio: "inherit", windowsHide: true, shell: false, timeout: 30000 },
);
if (result.error || result.status !== 0) throw Error("PAPER graceful control bundle failed");
console.log("Built canonical graceful protocol without copying source code");
