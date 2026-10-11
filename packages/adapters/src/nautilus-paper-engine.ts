import { createHash } from "node:crypto";
import type { PaperPerpetualEngine } from "@rakazo/adapter-kit";
import type {
  PaperPerpetualEngineBatch,
  PaperPerpetualEngineConfig,
  PaperPerpetualEngineSnapshot,
} from "@rakazo/contracts";
import { NautilusPaperProcess } from "./nautilus-paper-process.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
type Cached = {
  process: NautilusPaperProcess;
  configHash: string;
  sequence: number;
  outputHash: string | null;
};
/** One isolated native process per account. Replay compares every committed
 * result, including fees/funding/positions; mismatch blocks all further work.
 * Call invalidate after a failed enclosing database transaction.
 */
export class NautilusPaperEngine implements PaperPerpetualEngine {
  readonly id = "nautilus";
  readonly version = "1.231.0";
  private readonly accounts = new Map<string, Cached>();
  constructor(private readonly options: { pythonCommand: string; scriptPath: string }) {}
  async apply(
    config: PaperPerpetualEngineConfig,
    committed: readonly Readonly<{
      input: PaperPerpetualEngineBatch;
      output: PaperPerpetualEngineSnapshot;
    }>[],
    batch: PaperPerpetualEngineBatch,
  ): Promise<PaperPerpetualEngineSnapshot> {
    if (
      config.engineId !== "nautilus" ||
      config.engineVersion !== "1.231.0" ||
      batch.sequence !== committed.length + 1
    )
      throw new Error("Nautilus PAPER configuration or sequence mismatch");
    const configHash = digest(config),
      last = committed.at(-1);
    let cached = this.accounts.get(config.accountId);
    if (
      cached &&
      (cached.configHash !== configHash ||
        cached.sequence !== committed.length ||
        cached.outputHash !== (last ? digest(last.output) : null))
    ) {
      this.invalidate(config.accountId);
      cached = undefined;
    }
    try {
      if (!cached) {
        const process = await NautilusPaperProcess.start(this.options, {
          ...config,
          engineVersion: "1.231.0",
        });
        cached = { process, configHash, sequence: 0, outputHash: null };
        this.accounts.set(config.accountId, cached);
        for (const row of committed) {
          const replay = await process.apply(row.input);
          if (digest(replay) !== digest(row.output))
            throw new Error("Nautilus PAPER replay diverged");
          cached.sequence = replay.sequence;
          cached.outputHash = digest(replay);
        }
      }
      const result = await cached.process.apply(batch);
      cached.sequence = result.sequence;
      cached.outputHash = digest(result);
      return result;
    } catch (error) {
      this.invalidate(config.accountId);
      throw error;
    }
  }
  invalidate(accountId: string): void {
    const cached = this.accounts.get(accountId);
    this.accounts.delete(accountId);
    cached?.process.dispose();
  }
  dispose(): void {
    for (const accountId of this.accounts.keys()) this.invalidate(accountId);
  }
}
