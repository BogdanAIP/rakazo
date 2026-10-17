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
  idleTimer: ReturnType<typeof setTimeout> | null;
};
/** One isolated native process per account. Replay compares every committed
 * result, including fees/funding/positions; mismatch blocks all further work.
 * Call invalidate after a failed enclosing database transaction.
 */
export class NautilusPaperEngine implements PaperPerpetualEngine {
  readonly id = "nautilus";
  readonly version = "1.231.0";
  private readonly accounts = new Map<string, Cached>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly starting = new Map<string, object>();
  private disposed = false;
  constructor(private readonly options: { pythonCommand: string; scriptPath: string }) {}
  private runAccount<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(accountId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => {
        if (this.disposed) throw new Error("Nautilus PAPER engine disposed");
        return action();
      });
    this.operations.set(accountId, operation);
    const clear = () => {
      if (this.operations.get(accountId) === operation) this.operations.delete(accountId);
    };
    void operation.then(clear, clear);
    return operation;
  }
  private armIdleEviction(accountId: string, cached: Cached): void {
    if (cached.idleTimer) clearTimeout(cached.idleTimer);
    cached.idleTimer = setTimeout(
      () => {
        if (this.accounts.get(accountId) === cached) this.invalidate(accountId);
      },
      10 * 60 * 1000,
    );
    cached.idleTimer.unref();
  }
  requiresRecovery(accountId: string): boolean {
    return !this.accounts.has(accountId);
  }
  /** Replay committed native batches before entering a serializable transaction.
   * Cached state is accepted only when its last output matches the DB journal.
   */
  private async prepareAccount(
    config: PaperPerpetualEngineConfig,
    committed: readonly Readonly<{
      input: PaperPerpetualEngineBatch;
      output: PaperPerpetualEngineSnapshot;
    }>[],
  ): Promise<void> {
    if (config.engineId !== "nautilus" || config.engineVersion !== "1.231.0")
      throw new Error("Nautilus PAPER configuration mismatch");
    const configHash = digest(config);
    const last = committed.at(-1);
    let cached = this.accounts.get(config.accountId);
    if (cached?.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = null;
    }
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
        const token = {};
        this.starting.set(config.accountId, token);
        const process = await NautilusPaperProcess.start(this.options, {
          ...config,
          engineVersion: "1.231.0",
        });
        if (this.disposed || this.starting.get(config.accountId) !== token) {
          process.dispose();
          throw new Error("Nautilus PAPER startup invalidated");
        }
        this.starting.delete(config.accountId);
        cached = { process, configHash, sequence: 0, outputHash: null, idleTimer: null };
        this.accounts.set(config.accountId, cached);
        let cursor = 0;
        while (cursor < committed.length) {
          const group: (typeof committed)[number][] = [];
          let bytes = 0;
          while (cursor < committed.length && group.length < 16) {
            const item = committed[cursor]!;
            const size = JSON.stringify(item.input).length + JSON.stringify(item.output).length;
            if (group.length && bytes + size > 400_000) break;
            group.push(item);
            bytes += size;
            cursor += 1;
          }
          const snapshots =
            group.length === 1
              ? [await process.apply(group[0]!.input)]
              : await process.applyMany(group.map((item) => item.input));
          for (let index = 0; index < group.length; index += 1) {
            const replay = snapshots[index]!;
            if (digest(replay) !== digest(group[index]!.output))
              throw new Error("Nautilus PAPER replay diverged");
            cached.sequence = replay.sequence;
            cached.outputHash = digest(replay);
          }
        }
      }
      this.armIdleEviction(config.accountId, cached);
    } catch (error) {
      this.invalidate(config.accountId);
      throw error;
    }
  }
  prepare(
    config: PaperPerpetualEngineConfig,
    committed: readonly Readonly<{
      input: PaperPerpetualEngineBatch;
      output: PaperPerpetualEngineSnapshot;
    }>[],
  ): Promise<void> {
    return this.runAccount(config.accountId, () => this.prepareAccount(config, committed));
  }
  async apply(
    config: PaperPerpetualEngineConfig,
    committed: readonly Readonly<{
      input: PaperPerpetualEngineBatch;
      output: PaperPerpetualEngineSnapshot;
    }>[],
    batch: PaperPerpetualEngineBatch,
  ): Promise<PaperPerpetualEngineSnapshot> {
    return this.runAccount(config.accountId, async () => {
      if (batch.sequence !== committed.length + 1)
        throw new Error("Nautilus PAPER configuration or sequence mismatch");
      await this.prepareAccount(config, committed);
      const cached = this.accounts.get(config.accountId);
      if (!cached) throw new Error("Nautilus PAPER unavailable after recovery");
      try {
        const result = await cached.process.apply(batch);
        cached.sequence = result.sequence;
        cached.outputHash = digest(result);
        this.armIdleEviction(config.accountId, cached);
        return result;
      } catch (error) {
        this.invalidate(config.accountId);
        throw error;
      }
    });
  }
  invalidate(accountId: string): void {
    this.starting.delete(accountId);
    const cached = this.accounts.get(accountId);
    this.accounts.delete(accountId);
    if (cached?.idleTimer) clearTimeout(cached.idleTimer);
    cached?.process.dispose();
  }
  dispose(): void {
    this.disposed = true;
    this.starting.clear();
    for (const accountId of this.accounts.keys()) this.invalidate(accountId);
  }
}
