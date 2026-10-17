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

it("prepares committed native replay before a new batch and reuses the same child", async () => {
  const dispose = vi.fn();
  const previous = { sequence: 1, balanceQuote: "1000" } as PaperPerpetualEngineSnapshot;
  const current = { sequence: 2, balanceQuote: "1000" } as PaperPerpetualEngineSnapshot;
  const nativeApply = vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(current);
  vi.mocked(NautilusPaperProcess.start).mockResolvedValue({
    apply: nativeApply,
    dispose,
  } as unknown as NautilusPaperProcess);
  const engine = new NautilusPaperEngine({ pythonCommand: "stub", scriptPath: "stub" });
  const history = [{ input: batch, output: previous }];
  expect(engine.requiresRecovery(config.accountId)).toBe(true);

  await engine.prepare(config, history);
  expect(engine.requiresRecovery(config.accountId)).toBe(false);
  expect(NautilusPaperProcess.start).toHaveBeenCalledTimes(1);
  expect(nativeApply).toHaveBeenCalledTimes(1);

  expect(await engine.apply(config, history, { ...batch, sequence: 2 })).toEqual(current);
  expect(NautilusPaperProcess.start).toHaveBeenCalledTimes(1);
  expect(nativeApply).toHaveBeenCalledTimes(2);
  engine.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("refuses a corrupted committed native replay before trading", async () => {
  const dispose = vi.fn();
  vi.mocked(NautilusPaperProcess.start).mockResolvedValue({
    apply: vi.fn().mockResolvedValue({ sequence: 1, balanceQuote: "999" }),
    dispose,
  } as unknown as NautilusPaperProcess);
  const engine = new NautilusPaperEngine({ pythonCommand: "stub", scriptPath: "stub" });
  await expect(
    engine.prepare(config, [
      {
        input: batch,
        output: { sequence: 1, balanceQuote: "1000" } as PaperPerpetualEngineSnapshot,
      },
    ]),
  ).rejects.toThrow("Nautilus PAPER replay diverged");
  expect(engine.requiresRecovery(config.accountId)).toBe(true);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("coalesces concurrent account preparation without abandoning a native child", async () => {
  let ready!: (process: NautilusPaperProcess) => void;
  const dispose = vi.fn();
  const native = { dispose, apply: vi.fn() } as unknown as NautilusPaperProcess;
  vi.mocked(NautilusPaperProcess.start).mockReturnValue(
    new Promise((resolve) => {
      ready = resolve;
    }),
  );
  const engine = new NautilusPaperEngine({ pythonCommand: "stub", scriptPath: "stub" });
  const first = engine.prepare(config, []);
  const second = engine.prepare(config, []);
  await vi.waitFor(() => expect(NautilusPaperProcess.start).toHaveBeenCalledTimes(1));
  ready(native);
  await Promise.all([first, second]);
  expect(NautilusPaperProcess.start).toHaveBeenCalledTimes(1);
  engine.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it.each(["invalidate", "dispose"] as const)(
  "retires a native child when %s happens during startup",
  async (action) => {
    let ready!: (process: NautilusPaperProcess) => void;
    const dispose = vi.fn();
    const native = { dispose, apply: vi.fn() } as unknown as NautilusPaperProcess;
    vi.mocked(NautilusPaperProcess.start).mockReturnValue(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const engine = new NautilusPaperEngine({ pythonCommand: "stub", scriptPath: "stub" });
    const pending = engine.prepare(config, []);
    const rejected = expect(pending).rejects.toThrow("startup invalidated");
    await vi.waitFor(() => expect(NautilusPaperProcess.start).toHaveBeenCalledTimes(1));
    if (action === "dispose") engine.dispose();
    else engine.invalidate(config.accountId);
    ready(native);
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(engine.requiresRecovery(config.accountId)).toBe(true);
    engine.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  },
);
