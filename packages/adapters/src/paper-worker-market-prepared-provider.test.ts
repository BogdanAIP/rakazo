import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPreparedMarketResearchProvider,
  type PaperWorkerPreparedMarketResearch,
} from "./paper-worker-market-prepared-provider.js";
import type { PaperWorkerResolvedResearchProvider } from "./paper-worker-resolved-research-flow.js";

const now = new Date("2026-10-08T09:00:00.000Z");
const payload = {} as Parameters<PaperWorkerResolvedResearchProvider>[0];
const provenance = {
  semanticKey: "market.data",
  resolverKey: "resolver:market.data@1",
  resolverDigest: "a".repeat(64),
  implementation: {
    name: "CCXT MCP market tier",
    kind: "mcp",
    reference: "ccxt/ccxt",
    priority: 1,
    readOnly: true,
  },
  skill: {
    marketEntryId: "market-entry-1",
    marketKey: "ccxt-market",
    sourceDigest: "b".repeat(64),
    variant: "original",
  },
  resolvedAt: "2026-10-08T08:59:00.000Z",
} as const;

const prepared = {
  selection: {
    status: "ready",
    resolver: {
      semanticKey: provenance.semanticKey,
      key: provenance.resolverKey,
      digest: provenance.resolverDigest,
    },
    implementation: provenance.implementation,
    skill: {
      entryId: provenance.skill.marketEntryId,
      key: provenance.skill.marketKey,
      digest: provenance.skill.sourceDigest,
      variant: provenance.skill.variant,
    },
  },
  provenance,
  skillContent: "# Read-only CCXT research instructions",
} as const;

const signal = {
  kind: "proposal",
  signalId: "signal-1",
  strategyId: "market-strategy",
  strategyVersion: "1",
  createdAt: "2026-10-08T08:59:00.000Z",
  expiresAt: "2026-10-08T09:30:00.000Z",
  evidenceIds: ["public-market-fixture"],
  executionStatus: "research_only",
  market: {
    venue: "okx",
    kind: "spot",
    symbol: "SOL-USDT",
    base: "SOL",
    quote: "USDT",
    status: "active",
    priceIncrement: "0.01",
    quantityIncrement: "0.001",
    minNotional: "5",
    expiryAt: null,
  },
  action: "spot_buy",
  entryTrigger: "140",
  stopLoss: "136",
  takeProfit: ["145"],
  invalidation: "Price closes below support",
  rationale: "Research-only fixture",
  riskBudgetQuote: null,
  maxSlippageBps: null,
} as const;

function providerFor(
  snapshot: PaperWorkerPreparedMarketResearch,
  runResearch = vi.fn(async () => signal),
) {
  return {
    runner: runResearch,
    provider: createPreparedMarketResearchProvider(async () => snapshot, runResearch),
  };
}

describe("Market prepare -> Trading G6 research-only provider", () => {
  it("passes one verified Market preparation to a runner and produces a pinned Trading envelope", async () => {
    const { provider, runner } = providerFor(prepared);
    const envelope = await provider(payload, now);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(prepared, payload, now);
    expect(envelope).toMatchObject({
      schemaVersion: "trading-resolved-research-v1",
      mode: "research_only",
      executionAuthority: "none",
      provenance: {
        ...provenance,
        skill: {
          ...provenance.skill,
          contentSha256: createHash("sha256").update(prepared.skillContent).digest("hex"),
        },
      },
      signal,
    });
    expect(envelope).not.toHaveProperty("order");
  });

  it("preserves explicit NO_TRADE research outcomes", async () => {
    const noTrade = {
      kind: "no_trade",
      signalId: "signal-no-trade",
      strategyId: "market-strategy",
      strategyVersion: "1",
      createdAt: "2026-10-08T08:59:00.000Z",
      expiresAt: "2026-10-08T09:30:00.000Z",
      evidenceIds: ["public-market-fixture"],
      reason: "Research found no safe candidate.",
    } as const;
    const provider = createPreparedMarketResearchProvider(
      async () => prepared,
      async () => noTrade,
    );
    expect((await provider(payload, now)).signal).toEqual(noTrade);
  });

  it("changes the pinned instruction digest when Market switches a Skill variant", async () => {
    const original = prepared;
    const rccl = {
      ...prepared,
      skillContent: "# RCCL research-only instructions",
      selection: {
        ...prepared.selection,
        skill: { ...prepared.selection.skill, variant: "rccl" },
      },
      provenance: {
        ...provenance,
        skill: { ...provenance.skill, variant: "rccl" },
      },
    } as const;

    const first = await providerFor(original).provider(payload, now);
    const second = await providerFor(rccl).provider(payload, now);
    expect(first.provenance.skill?.contentSha256).not.toBe(second.provenance.skill?.contentSha256);
    expect(second.provenance.skill?.variant).toBe("rccl");
  });

  it("denies before invoking research if Market Resolver preparation is denied", async () => {
    const { provider, runner } = providerFor({
      selection: { status: "deny" },
      provenance: null,
      skillContent: null,
    });
    await expect(provider(payload, now)).rejects.toThrow("denied");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects changed Resolver identity and write-capable selection before any research", async () => {
    const wrongDigest = {
      ...prepared,
      selection: {
        ...prepared.selection,
        resolver: { ...prepared.selection.resolver, digest: "c".repeat(64) },
      },
    };
    const deniedWrite = {
      ...prepared,
      selection: {
        ...prepared.selection,
        implementation: { ...prepared.selection.implementation, readOnly: false },
      },
    };
    for (const snapshot of [wrongDigest, deniedWrite]) {
      const { provider, runner } = providerFor(snapshot);
      await expect(provider(payload, now)).rejects.toThrow();
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it("rejects changed/missing Skill provenance or content before the runner", async () => {
    const changedSkill = {
      ...prepared,
      selection: {
        ...prepared.selection,
        skill: { ...prepared.selection.skill, digest: "c".repeat(64) },
      },
    };
    const missingSkillContent = { ...prepared, skillContent: null };
    const unpinnedContent = {
      ...prepared,
      provenance: { ...provenance, skill: null },
      selection: { ...prepared.selection, skill: null },
    };
    for (const snapshot of [changedSkill, missingSkillContent, unpinnedContent]) {
      const { provider, runner } = providerFor(snapshot);
      await expect(provider(payload, now)).rejects.toThrow();
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it("rejects execution-capable signals, invalid clocks and runner failures", async () => {
    const unsafe = createPreparedMarketResearchProvider(
      async () => prepared,
      async () => ({
        ...signal,
        executionStatus: "live",
      }),
    );
    await expect(unsafe(payload, now)).rejects.toThrow();

    const { provider, runner } = providerFor(prepared);
    await expect(provider(payload, new Date("bad-clock"))).rejects.toThrow("clock");
    expect(runner).not.toHaveBeenCalled();

    const failed = createPreparedMarketResearchProvider(
      async () => prepared,
      async () => {
        throw new Error("public read-only capability unavailable");
      },
    );
    await expect(failed(payload, now)).rejects.toThrow("capability unavailable");
  });
});
