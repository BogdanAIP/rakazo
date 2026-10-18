import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Build the reviewed, existing journal UI as an isolated same-origin view.
// No owner data, session or grant is embedded in the browser bundle.
const [sourceRepo, expectedHead, outputDir] = process.argv.slice(2);
if (
  !sourceRepo ||
  !/^[a-f0-9]{40}$/.test(expectedHead ?? "") ||
  !outputDir ||
  !path.isAbsolute(sourceRepo) ||
  !path.isAbsolute(outputDir)
)
  throw Error("Usage: build.mjs <reviewed-ui-repository> <commit> <output-directory>");
const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRepo,
  encoding: "utf8",
  windowsHide: true,
});
const status = spawnSync("git", ["status", "--porcelain"], {
  cwd: sourceRepo,
  encoding: "utf8",
  windowsHide: true,
});
if (
  head.status !== 0 ||
  head.stdout.trim() !== expectedHead ||
  status.status !== 0 ||
  status.stdout.trim()
)
  throw Error("Journal UI source must match the reviewed clean commit");
const inside = (base, item) => {
  const relative = path.relative(path.resolve(base), path.resolve(item));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
for (const repo of [sourceRepo, path.resolve(import.meta.dirname, "../..")]) {
  if (inside(repo, outputDir) || inside(outputDir, repo))
    throw Error("Output must be outside the source checkouts");
}
try {
  const existing = await readdir(outputDir);
  if (existing.length) {
    const marker = JSON.parse(await readFile(path.join(outputDir, "build.json"), "utf8"));
    if (marker.kind !== "rakazo-linked-paper-ui-v1") throw Error("Unrecognized build directory");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const webRoot = path.join(sourceRepo, "apps/web");
process.chdir(webRoot);
const require = createRequire(path.join(webRoot, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const temp = await mkdtemp(path.join(os.tmpdir(), "rakazo-journal-build-"));
try {
  const file = (name) => path.join(temp, name);
  const source = (name) => JSON.stringify(path.join(webRoot, "src", name).replaceAll("\\", "/"));
  await writeFile(
    file("entry.tsx"),
    [
      'import { createRoot } from "react-dom/client";',
      "import { PaperPerpetualJournalPanel } from " +
        source("pages/PaperPerpetualJournalPanel.tsx") +
        ";",
      `import { I18nBootstrap } from ${source("components/I18nBootstrap.tsx")};`,
      `import { applyUiAppearance } from ${source("lib/ui-appearance.ts")};`,
      `import ${source("styles.css")};`,
      "applyUiAppearance();",
      'createRoot(document.getElementById("root")!).render(<I18nBootstrap>',
      '<main className="h-screen overflow-auto bg-background p-4 text-foreground">',
      '<h1 id="paper-journal-futures-tab" className="sr-only">Журнал PAPER</h1>',
      "<PaperPerpetualJournalPanel /></main></I18nBootstrap>);",
    ].join("\n"),
  );
  await writeFile(
    file("rpc.ts"),
    [
      'import { createORPCClient } from "@orpc/client";',
      'import { RPCLink } from "@orpc/client/fetch";',
      "export const rpc = createORPCClient(new RPCLink({",
      'url: () => window.location.origin + "/linked-paper/rpc",',
      'fetch: (request, init) => fetch(request, { ...init, credentials: "same-origin" })',
      "}));",
    ].join("\n"),
  );
  await mkdir(outputDir, { recursive: true });
  // Dependencies of the generated entry still resolve from the reviewed UI tree.
  await build({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    base: "/linked-paper/",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "linked-paper-rpc",
        enforce: "pre",
        resolveId(specifier, importer) {
          if (
            importer &&
            specifier.startsWith(".") &&
            path.resolve(path.dirname(importer), specifier).replace(/\.(?:js|ts)$/, "") ===
              path.join(webRoot, "src/lib/rpc")
          )
            return file("rpc.ts");
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: path.join(webRoot, "src/lib/rpc.ts").replaceAll("\\", "/"),
          replacement: file("rpc.ts"),
        },
        { find: /^react-dom\/client$/, replacement: require.resolve("react-dom/client") },
        { find: /^react\/jsx-runtime$/, replacement: require.resolve("react/jsx-runtime") },
        { find: /^react$/, replacement: require.resolve("react") },
        { find: /^@orpc\/client\/fetch$/, replacement: require.resolve("@orpc/client/fetch") },
        { find: /^@orpc\/client$/, replacement: require.resolve("@orpc/client") },
      ],
    },
    build: {
      outDir: outputDir,
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: file("entry.tsx"),
        formats: ["es"],
        fileName: () => "assets/journal.js",
        cssFileName: "journal",
      },
      rolldownOptions: {
        output: {
          assetFileNames: "assets/[name][extname]",
          chunkFileNames: "assets/[name]-[hash].js",
        },
      },
    },
  });
  const assets = await readdir(path.join(outputDir, "assets"));
  if (!assets.includes("journal.js")) throw Error("Journal bundle was not emitted");
  const styles = assets.filter((n) => n.endsWith(".css"));
  if (!styles.length) throw Error("Journal stylesheet was not emitted");
  await writeFile(
    path.join(outputDir, "index.html"),
    [
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>Журнал PAPER</title>",
      ...styles.map((n) => `<link rel="stylesheet" href="/linked-paper/assets/${n}">`),
      '</head><body><div id="root"></div>',
      '<script type="module" src="/linked-paper/assets/journal.js"></script></body></html>',
    ].join("\n"),
  );
  await writeFile(
    path.join(outputDir, "build.json"),
    JSON.stringify({
      kind: "rakazo-linked-paper-ui-v1",
      sourceHead: expectedHead,
      builtAt: new Date().toISOString(),
    }),
  );
  console.log("Existing PAPER journal UI built");
} finally {
  await rm(temp, { recursive: true, force: true });
}
