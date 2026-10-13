import type {
  PaperPerpetualEngineBatch,
  PaperPerpetualEngineConfig,
  PaperPerpetualEngineSnapshot,
} from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NautilusPaperEngine } from "./nautilus-paper-engine.js";
import { NautilusPaperProcess } from "./nautilus-paper-process.js";

vi.mock("./nautilus-paper-process.js", () => ({
  NautilusPaperProcess: { start: vi.fn() },
}));

const config: PaperPerpetualEngineConfig = {
  version: "paper_engine_config_v1",
  engineId: "nautilus",
  engineVersion: "1.231.0",
  accountId: "paper-cache-test",
  initialBalanceQuote: "1000",
  leverage: 2,
  instruments: [],
};
const batch: PaperPerpetualEngineBatch = { sequence: 1, quotes: [], commands: [], funding: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(NautilusPaperProcess.start).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it("disposes the native child after ten minutes without account activity", async () => {
  const dispose = vi.fn();
  vi.mocked(NautilusPaperProcess.start).mockResolvedValue({
    apply: vi.fn().mockResolvedValue({ sequence: 1 } as PaperPerpetualEngineSnapshot),
    dispose,
  } as unknown as NautilusPaperProcess);
  const engine = new NautilusPaperEngine({ pythonCommand: "stub", scriptPath: "stub" });

  await engine.apply(config, [], batch);
  vi.advanceTimersByTime(10 * 60 * 1000 - 1);
  expect(dispose).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  engine.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});
