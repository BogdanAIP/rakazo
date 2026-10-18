import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ScriptedAgentRuntime } from "@rakazo/adapters";
import type { PaperPerpetualSnapshot, TradingScanOutput } from "@rakazo/contracts";

/** Offline E2E fixtures. Production composition roots never select this model
 * or market provider; the browser still uses the real owner/RPC/queue/ledger.
 */
class PaperBrowserRuntime extends ScriptedAgentRuntime {
  override async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (!request.runId.startsWith("paper-futures-research:")) {
      yield* super.run(request, context);
      return;
    }
    const captured = JSON.parse(request.prompt).publicMarketData;
    const instrument = captured.allowedInstruments[0];
    yield {
      type: "done",
      text: JSON.stringify({
        kind: "proposal",
        instrument,
        side: "long",
        leverage: 1,
        quantityBase: "1",
        orderType: "market",
        limitPriceQuote: null,
        stopPriceQuote: "97",
        takeProfitPriceQuote: "110",
        plannedRecoveryNotionalQuote: "50",
        recoverySteps: [
          { stepId: "first-retest", triggerPriceQuote: "99", allocationPercent: 50 },
          { stepId: "second-retest", triggerPriceQuote: "98", allocationPercent: 50 },
        ],
        rationale:
          "Проверка браузерного сценария: виртуальный Long по публичному тестовому снимку.",
      }),
    };
  }
}
export function paperBrowserFixtures() {
  return {
    runtime: new PaperBrowserRuntime(),
    perpetualPaperResearchScan: async (): Promise<
      Pick<TradingScanOutput, "fetchedAt" | "candidates">
    > => ({
      fetchedAt: new Date().toISOString(),
      candidates: [],
    }),
    perpetualPaperSnapshot: async (instrument: string): Promise<PaperPerpetualSnapshot> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const now = new Date(),
        at = now.toISOString();
      return {
        market: {
          venue: "okx",
          kind: "perpetual",
          symbol: instrument,
          base: instrument.slice(0, -10),
          quote: "USDT",
          status: "active",
          priceIncrement: "0.01",
          quantityIncrement: "0.01",
          minNotional: null,
          expiryAt: null,
        },
        fetchedAt: at,
        leverageLimits: {
          venue: "okx",
          instrument,
          marginMode: "cross",
          sourceId: "public-tier-fixture",
          observedAt: at,
          tiers: [{ id: "1", minQuantityBase: "0", maxQuantityBase: "100", maxLeverage: 20 }],
        },
        book: {
          venue: "okx",
          instrument,
          sourceId: "public-e2e:" + at,
          observedAt: at,
          bidQuote: "100",
          askQuote: "100",
          bidAvailableBase: "100",
          askAvailableBase: "100",
        },
        rules: {
          basePerContract: "0.1",
          lotIncrementBase: "0.01",
          minimumBase: "0.01",
          maxTierBase: "100",
          maintenanceMarginBps: 50,
          maxLeverage: 20,
        },
        markPriceQuote: "100",
        markObservedAt: at,
        fundingNextAt: new Date(now.getTime() + 8 * 3600000).toISOString(),
        funding: [],
        history: [
          {
            venue: "okx",
            kind: "perpetual",
            symbol: instrument,
            openedAt: new Date(
              Math.floor(now.getTime() / 3600000) * 3600000 - 3600000,
            ).toISOString(),
            durationMs: 3600000,
            open: "99",
            high: "101",
            low: "98",
            close: "100",
            quoteVolume: "100000",
            confirmed: true,
          },
        ],
      };
    },
  };
}
