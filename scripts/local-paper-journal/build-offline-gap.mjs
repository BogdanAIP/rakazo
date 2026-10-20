import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const runtimeFile =
  process.env.RAKAZO_PAPER_RUNTIME_CONFIG ??
  path.join(
    os.homedir(),
    "RakazoRuntime",
    "trading-live-data-20261011",
    "paper-runtime-config.json",
  );
const config = JSON.parse(await readFile(runtimeFile, "utf8"));
if (!config?.repo || !path.isAbsolute(config.repo)) throw new Error("PAPER repo is not registered");
const repo = path.resolve(process.env.RAKAZO_OFFLINE_SOURCE_REPO ?? config.repo);
const toolRepo = path.resolve(config.repo);
const entry = path.join(repo, "scripts", "paper-offline-review.entry.ts");
if (!(await stat(entry)).isFile()) throw new Error("Canonical PAPER history reviewer is missing");
const store = path.join(toolRepo, "node_modules", ".pnpm");
const versions = (await readdir(store))
  .filter((name) => /^esbuild@\d/.test(name))
  .sort()
  .reverse();
if (versions.length !== 1) throw new Error("Ambiguous or missing pinned esbuild");
const esbuild = path.join(store, versions[0], "node_modules", "esbuild", "bin", "esbuild");
const output = path.join(root, "offline-gap-runtime.mjs");
const built = spawnSync(
  process.execPath,
  [
    esbuild,
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--outfile=" + output,
    "--alias:@rakazo/contracts=" + path.join(repo, "packages", "contracts", "src", "index.ts"),
  ],
  { stdio: "inherit", timeout: 30000, shell: false, windowsHide: true },
);
if (built.error || built.status !== 0)
  throw new Error("Canonical PAPER offline bundle build failed");
console.log("Canonical offline reviewer bundle built without duplicate algorithms");
