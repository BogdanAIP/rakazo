import { loadWindowsHostConfig } from "./config.js";
import { WindowsHostRuntime } from "./runtime.js";

const config = loadWindowsHostConfig();
const runtime = new WindowsHostRuntime(config);

if (process.argv.includes("--probe")) {
  process.stdout.write(`${JSON.stringify(await runtime.probe(), null, 2)}\n`);
  process.exit(0);
}

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

try {
  await runtime.run(controller.signal);
} catch (error) {
  if (!controller.signal.aborted) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`windows-host: ${message}\n`);
    process.exitCode = 1;
  }
}
