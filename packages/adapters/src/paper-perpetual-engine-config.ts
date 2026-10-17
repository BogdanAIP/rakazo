import { isAbsolute } from "node:path";
import { NautilusPaperEngine } from "./nautilus-paper-engine.js";
/** Trusted local process configuration. No model, RPC or exchange credentials. */
export function createConfiguredPaperPerpetualEngine(env: NodeJS.ProcessEnv = process.env) {
  const pythonCommand = env.PAPER_NAUTILUS_PYTHON,
    scriptPath = env.PAPER_NAUTILUS_SCRIPT;
  if (!pythonCommand && !scriptPath) return undefined;
  if (!pythonCommand || !scriptPath || !isAbsolute(pythonCommand) || !isAbsolute(scriptPath))
    throw new Error("PAPER futures engine requires absolute trusted executable and script paths");
  return new NautilusPaperEngine({ pythonCommand, scriptPath });
}
