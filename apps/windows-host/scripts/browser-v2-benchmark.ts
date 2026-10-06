import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { WindowsHostBrowserRequest, WindowsHostBrowserResult } from "@rakazo/contracts";
import {
  loadOpenCliConfiguration,
  type OpenCliRunner,
  runOpenCliProcess,
  WindowsOpenCliBackend,
} from "../src/opencli.js";
import {
  type PlaywrightCliRunner,
  runPlaywrightCliProcess,
  WindowsPlaywrightCliBackend,
} from "../src/playwright-cli.js";
import { loadPlaywrightCliConfiguration } from "../src/playwright-cli-config.js";

type BenchMode = "opencli" | "playwright-cli-cdp";

interface ProcessMetrics {
  calls: number;
  rawBytes: number;
  elapsedMs: number;
}

interface CommandMetric {
  label: string;
  elapsedMs: number;
  ok: boolean;
  uncertain: boolean;
  responseBytes: number;
  modelVisibleChars: number;
}

interface IterationResult {
  ok: boolean;
  formVerified: boolean;
  recoveryVerified: boolean;
  commands: CommandMetric[];
  process: ProcessMetrics;
  error?: string;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)]!;
}

function normalizedResult(result: WindowsHostBrowserResult): string {
  const copy = { ...result, imageBase64: result.imageBase64 ? "<omitted>" : undefined };
  return JSON.stringify(copy);
}

function parseArgs() {
  let iterations = 5;
  let modes: BenchMode[] = ["opencli", "playwright-cli-cdp"];

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--iterations=")) {
      const value = Number(arg.slice("--iterations=".length));
      if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
        throw new Error("--iterations must be an integer from 1 to 50");
      }
      iterations = value;
    } else if (arg.startsWith("--modes=")) {
      const requested = arg
        .slice("--modes=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        requested.length === 0 ||
        requested.some((value) => value !== "opencli" && value !== "playwright-cli-cdp")
      ) {
        throw new Error("--modes accepts opencli,playwright-cli-cdp");
      }
      modes = [...new Set(requested)] as BenchMode[];
    }
  }

  return { iterations, modes };
}

async function localSite() {
  const heavy = Array.from(
    { length: 500 },
    (_, index) => `<button>Item ${index}</button><a href="#item-${index}">Link ${index}</a>`,
  ).join("");
  const pages = new Map<string, string>([
    [
      "/basic",
      '<!doctype html><title>BV2 Basic</title><h1>BV2 Basic</h1><a href="/clicked">Go</a>',
    ],
    [
      "/clicked",
      "<!doctype html><title>BV2 Clicked</title><h1>Clicked</h1><p>semantic click ok</p>",
    ],
    [
      "/form",
      `<!doctype html><title>BV2 Form</title>
<form><label for="name">Name</label><input id="name" name="name"><button>Submit</button></form>
<p id="status"></p>
<script>
document.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#status").textContent =
    "Hello " + document.querySelector("#name").value;
});
</script>`,
    ],
    ["/heavy", `<!doctype html><title>BV2 Heavy</title><h1>Heavy DOM</h1><main>${heavy}</main>`],
    [
      "/canvas",
      `<!doctype html><title>BV2 Canvas</title><h1>Canvas fallback</h1>
<canvas id="surface" width="640" height="320"></canvas>
<script>
const ctx = document.querySelector("#surface").getContext("2d");
ctx.font = "24px sans-serif";
ctx.fillText("BV2 canvas fallback", 40, 80);
ctx.fillRect(40, 120, 220, 80);
</script>`,
    ],
  ]);

  const server = createServer((request, response) => {
    const body = pages.get(request.url ?? "");
    response.writeHead(body ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body ?? "missing");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local benchmark server failed");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function measuredOpenCliRunner(metrics: ProcessMetrics): OpenCliRunner {
  return async (entry, argv) => {
    const started = performance.now();
    metrics.calls += 1;
    const output = await runOpenCliProcess(entry, argv);
    metrics.elapsedMs += performance.now() - started;
    metrics.rawBytes += Buffer.byteLength(output);
    return output;
  };
}

function measuredPlaywrightRunner(metrics: ProcessMetrics): PlaywrightCliRunner {
  return async (entry, argv, cwd, timeoutMs) => {
    const started = performance.now();
    metrics.calls += 1;
    const output = await runPlaywrightCliProcess(entry, argv, cwd, timeoutMs);
    metrics.elapsedMs += performance.now() - started;
    metrics.rawBytes += Buffer.byteLength(output);
    return output;
  };
}

function createBackend(mode: BenchMode, stateDir: string, processMetrics: ProcessMetrics) {
  if (mode === "opencli") {
    return new WindowsOpenCliBackend(
      loadOpenCliConfiguration(),
      measuredOpenCliRunner(processMetrics),
    );
  }

  const config = loadPlaywrightCliConfiguration({
    ...process.env,
    RAKAZO_BROWSER_BACKEND: "playwright-cli-cdp",
    RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL:
      process.env.RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL?.trim() || "chrome",
  });
  return new WindowsPlaywrightCliBackend(
    config,
    stateDir,
    measuredPlaywrightRunner(processMetrics),
  );
}

async function runIteration(mode: BenchMode, baseUrl: string, iteration: number) {
  const processMetrics: ProcessMetrics = { calls: 0, rawBytes: 0, elapsedMs: 0 };
  const stateDir = path.join(os.tmpdir(), `rakazo-bv2-bench-${process.pid}-${mode}-${iteration}`);
  const backend = createBackend(mode, stateDir, processMetrics);
  const commands: CommandMetric[] = [];
  const botId = `bv2bench-${iteration}`;
  let token: string | undefined;
  let formVerified = false;
  let recoveryVerified = false;

  const call = async (label: string, request: WindowsHostBrowserRequest) => {
    const started = performance.now();
    const result = await backend.browser(botId, request);
    const elapsedMs = performance.now() - started;
    const normalized = normalizedResult(result);
    commands.push({
      label,
      elapsedMs,
      ok: result.ok,
      uncertain: Boolean(result.uncertain),
      responseBytes: Buffer.byteLength(normalized),
      modelVisibleChars: (result.tree?.length ?? 0) + (result.content?.length ?? 0),
    });
    if (!result.ok) throw new Error(`${label}: ${result.error ?? "failed"}`);
    return result;
  };

  try {
    const opened = await call("open", { command: "open" });
    token = opened.sessionToken;
    if (!token) throw new Error("open did not return a session token");

    await call("navigate-basic", {
      command: "navigate",
      sessionToken: token,
      url: `${baseUrl}/basic`,
    });
    const basic = await call("snapshot-basic", { command: "snapshot", sessionToken: token });
    const go = basic.elements?.find((element) => /Go/iu.test(element.name));
    if (!go) throw new Error("snapshot-basic did not expose the Go link");
    await call("click-basic", {
      command: "act",
      sessionToken: token,
      actions: [{ kind: "click", ref: go.ref }],
    });

    await call("navigate-form", {
      command: "navigate",
      sessionToken: token,
      url: `${baseUrl}/form`,
    });
    const form = await call("snapshot-form", { command: "snapshot", sessionToken: token });
    const textbox = form.elements?.find(
      (element) => element.role === "textbox" || /Name/iu.test(element.name),
    );
    const submit = form.elements?.find(
      (element) => element.role === "button" && /Submit/iu.test(element.name),
    );
    if (!textbox || !submit) throw new Error("snapshot-form did not expose form refs");
    await call("fill-submit", {
      command: "act",
      sessionToken: token,
      actions: [
        { kind: "fill", ref: textbox.ref, text: "Rakazo" },
        { kind: "click", ref: submit.ref },
      ],
    });
    const verified = await call("snapshot-verify", { command: "snapshot", sessionToken: token });
    formVerified = (verified.tree ?? verified.content ?? "").includes("Hello Rakazo");
    if (!formVerified) throw new Error("form result was not visible after submit");

    const heavy = await call("tab-new-heavy", {
      command: "tabNew",
      sessionToken: token,
      url: `${baseUrl}/heavy`,
    });
    await call("snapshot-heavy", { command: "snapshot", sessionToken: token });
    await call("screenshot-heavy", {
      command: "screenshot",
      sessionToken: token,
      width: 800,
      height: 600,
    });
    if (heavy.pageId) {
      await call("tab-close-heavy", {
        command: "tabClose",
        sessionToken: token,
        pageId: heavy.pageId,
      });
    }

    await call("navigate-canvas", {
      command: "navigate",
      sessionToken: token,
      url: `${baseUrl}/canvas`,
    });
    await call("screenshot-canvas", {
      command: "screenshot",
      sessionToken: token,
      width: 800,
      height: 600,
    });

    const recoveredBackend = createBackend(mode, stateDir, processMetrics);
    const started = performance.now();
    const recovered = await recoveredBackend.browser(botId, {
      command: "recover",
      sessionToken: token,
    });
    commands.push({
      label: "recover-new-backend",
      elapsedMs: performance.now() - started,
      ok: recovered.ok,
      uncertain: Boolean(recovered.uncertain),
      responseBytes: Buffer.byteLength(normalizedResult(recovered)),
      modelVisibleChars: (recovered.tree?.length ?? 0) + (recovered.content?.length ?? 0),
    });
    recoveryVerified = recovered.ok;
    if (!recovered.ok) throw new Error(`recover-new-backend: ${recovered.error ?? "failed"}`);

    const closeStarted = performance.now();
    const closed = await recoveredBackend.browser(botId, { command: "close", sessionToken: token });
    commands.push({
      label: "close",
      elapsedMs: performance.now() - closeStarted,
      ok: closed.ok,
      uncertain: Boolean(closed.uncertain),
      responseBytes: Buffer.byteLength(normalizedResult(closed)),
      modelVisibleChars: (closed.tree?.length ?? 0) + (closed.content?.length ?? 0),
    });
    if (!closed.ok) throw new Error(`close: ${closed.error ?? "failed"}`);

    return { ok: true, formVerified, recoveryVerified, commands, process: processMetrics };
  } catch (error) {
    if (token) {
      try {
        await backend.browser(botId, { command: "close", sessionToken: token });
      } catch {
        // Benchmark cleanup must not mask the original failure.
      }
    }
    return {
      ok: false,
      formVerified,
      recoveryVerified,
      commands,
      process: processMetrics,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("BV2 physical benchmark is Windows-only");
  const { iterations, modes } = parseArgs();
  const site = await localSite();

  try {
    const report: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      iterations,
      target: "deterministic-local-http",
      modes: {},
    };

    for (const mode of modes) {
      const results: IterationResult[] = [];
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        results.push(await runIteration(mode, site.baseUrl, iteration));
      }

      const commands = results.flatMap((result) => result.commands);
      const latencies = commands.map((command) => command.elapsedMs);
      const successfulIterations = results.filter((result) => result.ok).length;
      (report.modes as Record<string, unknown>)[mode] = {
        successRate: successfulIterations / iterations,
        successfulIterations,
        medianLatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        processCalls: results.reduce((sum, result) => sum + result.process.calls, 0),
        processElapsedMs: results.reduce((sum, result) => sum + result.process.elapsedMs, 0),
        rawProcessBytes: results.reduce((sum, result) => sum + result.process.rawBytes, 0),
        responseBytes: commands.reduce((sum, command) => sum + command.responseBytes, 0),
        modelVisibleChars: commands.reduce((sum, command) => sum + command.modelVisibleChars, 0),
        ambiguousMutations: commands.filter((command) => command.uncertain).length,
        recoverySuccessRate:
          results.filter((result) => result.recoveryVerified).length / iterations,
        formSuccessRate: results.filter((result) => result.formVerified).length / iterations,
        failures: results.filter((result) => !result.ok).map((result) => result.error),
        commandMetrics: commands,
      };
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await site.close();
  }
}

await main();
