import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { PaperPerpetualEngineSnapshot } from "@rakazo/contracts";
import { PaperPerpetualEngineSnapshotSchema as Snapshot } from "@rakazo/contracts";

export type NautilusPaperConfig = Readonly<{
  accountId: string;
  engineVersion: "1.231.0";
  initialBalanceQuote: "1000";
  leverage: number;
  instruments: readonly Readonly<{
    instrument: string;
    priceIncrement: string;
    quantityIncrement: string;
    minimumBase: string;
    maximumBase: string;
    maintenanceRate: string;
    makerFeeRate: string;
    takerFeeRate: string;
  }>[];
}>;

export type NautilusPaperBatch = Readonly<{
  leverage?: number;
  sequence: number;
  quotes: readonly Readonly<{
    instrument: string;
    atNs: string;
    bidQuote: string;
    askQuote: string;
    markPriceQuote?: string;
    bidAvailableBase: string;
    askAvailableBase: string;
  }>[];
  commands: readonly (
    | Readonly<{ kind: "cancel"; instrument: string; orderId: string }>
    | Readonly<{
        kind: "order";
        orderId: string;
        positionId: string;
        instrument: string;
        action: "buy" | "sell";
        quantityBase: string;
        reduceOnly: boolean;
        orderType: "market" | "limit";
        limitPriceQuote: string | null;
      }>
  )[];
  funding: readonly Readonly<{ instrument: string; atNs: string; rateSigned: string }>[];
}>;

export type NautilusPaperSnapshot = PaperPerpetualEngineSnapshot;

/** One native process per account: Nautilus has process-global actor registries.
 * Paths are supplied only by the trusted composition root, never a model/RPC.
 * No HTTP listener, shell execution, exchange client or credential input.
 * The caller must durably persist authorized batches before applying them and
 * reconcile/replay after any transport failure; this adapter cannot grant Start.
 */
export class NautilusPaperProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly accountId: string;
  private pending:
    | { resolve: (result: unknown) => void; reject: (error: Error) => void }
    | undefined;
  private failed = false;
  private failureReason = "unavailable";
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(options: { pythonCommand: string; scriptPath: string }, accountId: string) {
    this.accountId = accountId;
    this.child = spawn(options.pythonCommand, ["-u", options.scriptPath], {
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    // Consume diagnostics without returning native tracebacks/private paths to clients.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!this.pending || line.length > 1024 * 1024) {
        this.fail();
        return;
      }
      try {
        const result: unknown = JSON.parse(line);
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(result);
      } catch {
        this.fail();
      }
    });
    this.child.once("error", () => this.fail("spawn_failed"));
    this.child.once("exit", (code) => this.fail("process_exited", code));
  }

  static async start(
    options: { pythonCommand: string; scriptPath: string },
    config: NautilusPaperConfig,
  ): Promise<NautilusPaperProcess> {
    const process = new NautilusPaperProcess(options, config.accountId);
    try {
      const result = (await process.request({ action: "initialize", config }, 60_000)) as {
        status?: unknown;
        engineVersion?: unknown;
      };
      if (result.status !== "ready" || result.engineVersion !== config.engineVersion) {
        throw new Error("Nautilus PAPER initialization failed");
      }
      return process;
    } catch (error) {
      process.dispose();
      throw error;
    }
  }

  apply(batch: NautilusPaperBatch): Promise<NautilusPaperSnapshot> {
    const operation = this.queue.then(async () => {
      const raw = await this.request({ action: "apply", batch });
      if (
        raw === null ||
        typeof raw !== "object" ||
        (raw as { version?: unknown }).version !== "nautilus_paper_v1"
      ) {
        this.fail();
        throw new Error("Invalid Nautilus PAPER response");
      }
      const parsed = Snapshot.safeParse({
        ...raw,
        version: "paper_engine_snapshot_v1",
        engineId: "nautilus",
      });
      if (!parsed.success) {
        this.fail();
        throw new Error("Invalid Nautilus PAPER response");
      }
      const result = parsed.data;
      if (
        result.version !== "paper_engine_snapshot_v1" ||
        result.engineVersion !== "1.231.0" ||
        result.marginMode !== "account_wide" ||
        result.accountId !== this.accountId ||
        result.sequence !== batch.sequence
      ) {
        this.fail();
        throw new Error("Nautilus PAPER response identity mismatch");
      }
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  /** Replays a bounded group in one IPC round trip, but preserves and validates
   * every intermediate native output; no journal entry may be skipped.
   */
  applyMany(batches: readonly NautilusPaperBatch[]): Promise<NautilusPaperSnapshot[]> {
    if (!batches.length || batches.length > 16)
      return Promise.reject(new Error("Invalid native replay group"));
    const operation = this.queue.then(async () => {
      const raw = await this.request({ action: "apply_many", batches }, 60_000);
      if (!Array.isArray(raw) || raw.length !== batches.length) {
        this.fail();
        throw new Error("Invalid Nautilus PAPER replay response");
      }
      return raw.map((value: unknown, index: number) => {
        if (
          value === null ||
          typeof value !== "object" ||
          (value as { version?: unknown }).version !== "nautilus_paper_v1"
        ) {
          this.fail();
          throw new Error("Invalid Nautilus PAPER replay item");
        }
        const parsed = Snapshot.safeParse({
          ...value,
          version: "paper_engine_snapshot_v1",
          engineId: "nautilus",
        });
        if (
          !parsed.success ||
          parsed.data.engineVersion !== "1.231.0" ||
          parsed.data.accountId !== this.accountId ||
          parsed.data.marginMode !== "account_wide" ||
          parsed.data.sequence !== batches[index]!.sequence
        ) {
          this.fail();
          throw new Error("Nautilus PAPER replay identity mismatch");
        }
        return parsed.data;
      });
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private request(value: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.failed || this.pending)
      return Promise.reject(new Error(`Nautilus PAPER unavailable (${this.failureReason})`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("request_timeout"), timeoutMs);
      this.pending = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) this.fail("write_failed");
      });
    });
  }

  private fail(reason = "protocol_violation", exitCode?: number | null): void {
    if (this.failed) return;
    this.failed = true;
    this.failureReason = Number.isInteger(exitCode) ? `${reason}, exit=${exitCode}` : reason;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(
      new Error(`Nautilus PAPER unavailable (${this.failureReason}); reconcile committed inputs`),
    );
    this.child.kill();
  }

  dispose(): void {
    this.fail("disposed");
  }
}
