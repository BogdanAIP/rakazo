import { recordPublicAdapterPaperQuoteEvidence } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePublicPaperSpotEvidence } from "./trading-paper-public-capture.js";

vi.mock("@rakazo/db", () => ({
  recordIdempotentPublicAdapterPaperQuoteEvidence: vi.fn(async () => ({
    id: "worker-stored",
    source: "public_adapter_observation",
  })),
  recordPublicAdapterPaperQuoteEvidence: vi.fn(async () => ({
    id: "synthetic-stored",
    source: "public_adapter_observation",
  })),
}));
const owner = { userId: "user-test", spaceId: "space-test" };
const db = {} as Parameters<typeof capturePublicPaperSpotEvidence>[0];
const now = () => Date.now();
function mockResponses(values: unknown[]) {
  const responses = [...values];
  const fn = vi.fn(async (_url: unknown, _options: unknown) => {
    if (responses.length === 0) throw new Error("Unexpected public request");
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("internal, opt-in public spot evidence capture", () => {
  it("uses only fixed BingX public endpoints and tags actual adapter output", async () => {
    const fake = mockResponses([
      {
        code: 0,
        data: {
          symbols: [
            {
              symbol: "SOL-USDT",
              status: 1,
              tickSize: "0.01",
              stepSize: "0.01",
              minNotional: "5",
            },
          ],
        },
      },
      {
        code: 0,
        data: [
          {
            symbol: "SOL-USDT",
            bidPrice: "100",
            askPrice: "100.1",
            quoteVolume: "123000",
            closeTime: now(),
          },
        ],
      },
    ]);
    await expect(
      capturePublicPaperSpotEvidence(db, owner, "paper-test", {
        venue: "bingx",
        symbol: "SOL-USDT",
      }),
    ).resolves.toEqual({ id: "synthetic-stored", source: "public_adapter_observation" });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(fake.mock.calls.map((args) => String(args[0]).split("?")[0])).toEqual([
      "https://open-api.bingx.com/openApi/spot/v1/common/symbols",
      "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr",
    ]);
    expect(recordPublicAdapterPaperQuoteEvidence).toHaveBeenCalledOnce();
    const args = vi.mocked(recordPublicAdapterPaperQuoteEvidence).mock.calls[0];
    expect(args?.[3]).toMatchObject({
      venue: "bingx",
      kind: "spot",
      symbol: "SOL-USDT",
      status: "active",
    });
    expect(args?.[4]).toMatchObject({
      venue: "bingx",
      symbol: "SOL-USDT",
      bid: "100",
      ask: "100.1",
    });
    for (const call of fake.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(JSON.stringify(options.headers)).not.toMatch(/api.?key|authorization|signature/i);
    }
  });
  it("rejects missing ticker/inactive market and does not persist anything", async () => {
    mockResponses([
      {
        code: 0,
        data: { symbols: [{ symbol: "SOL-USDT", status: 0, tickSize: "0.01", stepSize: "0.01" }] },
      },
      { code: 0, data: [] },
    ]);
    await expect(
      capturePublicPaperSpotEvidence(db, owner, "paper-test", {
        venue: "bingx",
        symbol: "SOL-USDT",
      }),
    ).rejects.toThrow("unavailable");
    expect(recordPublicAdapterPaperQuoteEvidence).not.toHaveBeenCalled();
  });
  it("uses only four fixed keyless OKX catalog/ticker endpoints", async () => {
    const at = now();
    const fake = mockResponses([
      {
        code: "0",
        data: [
          {
            instType: "SPOT",
            instId: "SOL-USDT",
            state: "live",
            ruleType: "normal",
            baseCcy: "SOL",
            quoteCcy: "USDT",
            tickSz: "0.01",
            lotSz: "0.01",
            expTime: "",
          },
        ],
      },
      { code: "0", data: [] },
      { code: "0", data: [] },
      {
        code: "0",
        data: [
          {
            instType: "SPOT",
            instId: "SOL-USDT",
            bidPx: "100",
            askPx: "100.1",
            volCcy24h: "120000",
            ts: String(at),
          },
        ],
      },
    ]);
    await expect(
      capturePublicPaperSpotEvidence(db, owner, "paper-test", {
        venue: "okx",
        symbol: "SOL-USDT",
      }),
    ).resolves.toEqual({ id: "synthetic-stored", source: "public_adapter_observation" });
    expect(fake.mock.calls.map((args) => String(args[0]))).toEqual([
      "https://www.okx.com/api/v5/public/instruments?instType=SPOT",
      "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
      "https://www.okx.com/api/v5/public/instruments?instType=FUTURES",
      "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
    ]);
    expect(recordPublicAdapterPaperQuoteEvidence).toHaveBeenCalledOnce();
    expect(vi.mocked(recordPublicAdapterPaperQuoteEvidence).mock.calls[0]?.[3]).toMatchObject({
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      status: "active",
    });
    for (const call of fake.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(JSON.stringify(options.headers)).not.toMatch(/api.?key|authorization|signature/i);
    }
  });
  it("rejects invalid target without making a public request or DB write", async () => {
    const fake = mockResponses([]);
    await expect(
      capturePublicPaperSpotEvidence(db, owner, "paper-test", {
        venue: "okx",
        symbol: "SOL/USDT",
      }),
    ).rejects.toThrow("Invalid");
    expect(fake).not.toHaveBeenCalled();
    expect(recordPublicAdapterPaperQuoteEvidence).not.toHaveBeenCalled();
  });
});
