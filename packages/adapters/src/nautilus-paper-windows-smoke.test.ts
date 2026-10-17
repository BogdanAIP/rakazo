import { fileURLToPath } from "node:url";
import type { PaperPerpetualEngineBatch, PaperPerpetualEngineConfig } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { NautilusPaperEngine } from "./nautilus-paper-engine.js";

const suite = process.env.PAPER_NAUTILUS_PYTHON ? describe : describe.skip;

suite("Windows Node-to-native PAPER engine smoke", () => {
  it("hedges, restarts native process, verifies committed replay and closes reduce-only", async () => {
    const pythonCommand = process.env.PAPER_NAUTILUS_PYTHON;
    if (!pythonCommand) throw new Error("Isolated PAPER Python is required");
    const config: PaperPerpetualEngineConfig = {
      version: "paper_engine_config_v1",
      engineId: "nautilus",
      engineVersion: "1.231.0",
      accountId: "native-windows-smoke",
      initialBalanceQuote: "1000",
      leverage: 5,
      instruments: [
        {
          instrument: "BTC-USDT-SWAP",
          priceIncrement: "0.01",
          quantityIncrement: "0.01",
          minimumBase: "0.01",
          maximumBase: "100.00",
          maintenanceRate: "0.005",
          makerFeeRate: "0.0002",
          takerFeeRate: "0.0005",
        },
      ],
    };
    const makeOrder = (
      orderId: string,
      positionId: string,
      action: "buy" | "sell",
      reduceOnly = false,
    ) => ({
      kind: "order" as const,
      orderId,
      positionId,
      action,
      instrument: "BTC-USDT-SWAP",
      quantityBase: "1.00",
      reduceOnly,
      orderType: "market" as const,
      limitPriceQuote: null,
    });
    const makeBatch = (
      sequence: number,
      commands: PaperPerpetualEngineBatch["commands"],
    ): PaperPerpetualEngineBatch => ({
      sequence,
      commands,
      funding: [],
      quotes: [
        {
          instrument: "BTC-USDT-SWAP",
          atNs: String(1704067200000000000n + BigInt(sequence) * 1000000000n),
          bidQuote: "100.00",
          askQuote: "100.00",
          markPriceQuote: "100.00",
          bidAvailableBase: "100.00",
          askAvailableBase: "100.00",
        },
      ],
    });
    const engine = new NautilusPaperEngine({
      pythonCommand,
      scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
    });
    try {
      const input1 = makeBatch(1, [makeOrder("w-long", "W_LONG", "buy")]);
      const output1 = await engine.apply(config, [], input1);
      const input2 = makeBatch(2, [makeOrder("w-short", "W_SHORT", "sell")]);
      const output2 = await engine.apply(config, [{ input: input1, output: output1 }], input2);
      expect(output2.positions.map((position) => position.side).sort()).toEqual(["LONG", "SHORT"]);
      expect(output2.openOrders).toHaveLength(0);

      // A fresh Python process must reconstruct both hedged positions exactly.
      engine.invalidate(config.accountId);
      const committed = [
        { input: input1, output: output1 },
        { input: input2, output: output2 },
      ];
      const input3 = makeBatch(3, [
        makeOrder("w-close-long", "W_LONG", "sell", true),
        makeOrder("w-close-short", "W_SHORT", "buy", true),
      ]);
      const output3 = await engine.apply(config, committed, input3);
      expect(output3.sequence).toBe(3);
      expect(output3.positions).toHaveLength(0);
      expect(output3.openOrders).toHaveLength(0);
      expect(output3.liquidations).toBe(0);
      expect(Number(output3.totalFeesQuote)).toBeGreaterThan(Number(output2.totalFeesQuote));
    } finally {
      engine.dispose();
    }
  }, 120000);
});
