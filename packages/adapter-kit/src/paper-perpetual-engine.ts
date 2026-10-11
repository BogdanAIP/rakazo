import type {
  PaperPerpetualEngineBatch,
  PaperPerpetualEngineConfig,
  PaperPerpetualEngineSnapshot,
} from "@rakazo/contracts";

/** Trusted composition-only simulator port. No trading permissions or real venue calls.
 * A failed database commit must invalidate any uncommitted process state.
 */
export interface PaperPerpetualEngine {
  readonly id: string;
  readonly version: string;
  apply(
    config: PaperPerpetualEngineConfig,
    committed: readonly Readonly<{
      input: PaperPerpetualEngineBatch;
      output: PaperPerpetualEngineSnapshot;
    }>[],
    batch: PaperPerpetualEngineBatch,
  ): Promise<PaperPerpetualEngineSnapshot>;
  invalidate(accountId: string): void;
  dispose?(): void;
}
