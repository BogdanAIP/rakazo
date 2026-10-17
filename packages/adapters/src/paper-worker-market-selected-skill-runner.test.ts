import { createHash } from "node:crypto";
import { resolvedTradingResearchApprovalScope } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  createPreparedMarketResearchProvider,
  type PaperWorkerPreparedMarketResearch,
} from "./paper-worker-market-prepared-provider.js";
import {
  createSelectedMarketSkillResearchRunner,
  type SelectedMarketSkillResearchRequest,
} from "./paper-worker-market-selected-skill-runner.js";
import type { PaperWorkerResolvedResearchProvider } from "./paper-worker-resolved-research-flow.js";

const now = new Date("2026-10-08T16:30:00.000Z");
const payload = {} as Parameters<PaperWorkerResolvedResearchProvider>[0];
const digest = "a".repeat(64);

function preparedFor(
  variant: "original" | "rccl" | "wrapped" | "hybrid",
  instructions: string,
): PaperWorkerPreparedMarketResearch {
  return {
    selection: {
      status: "ready",
      resolver: { semanticKey: "market.analysis", key: "resolver:market.analysis", digest },
      implementation: {
        name: "Read-only Market Skill",
        kind: "mcp",
        reference: "market:vendor/analysis:technical-analysis",
        priority: 1,
        readOnly: true,
      },
      skill: { entryId: "entry-1", key: "market-skill-key", digest, variant },
    },
    provenance: {
      semanticKey: "market.analysis",
      resolverKey: "resolver:market.analysis",
      resolverDigest: digest,
      implementation: {
        name: "Read-only Market Skill",
        kind: "mcp",
        reference: "market:vendor/analysis:technical-analysis",
        priority: 1,
        readOnly: true,
      },
      skill: {
        marketEntryId: "entry-1",
        marketKey: "market-skill-key",
        sourceDigest: digest,
        variant,
      },
      resolvedAt: now.toISOString(),
    },
    skillContent: instructions,
  };
}

const noTrade = {
  kind: "no_trade",
  signalId: "skill-research-1",
  strategyId: "paper-skill-research",
  strategyVersion: "1",
  createdAt: now.toISOString(),
  expiresAt: "2026-10-08T17:30:00.000Z",
  evidenceIds: ["public-data-1"],
  reason: "No trustworthy research signal was found",
};

describe("RCCL and adapted Market Skill research runner", () => {
  it.each(["original", "rccl", "wrapped", "hybrid"] as const)(
    "passes the exact %s variant's instruction text and content digest into G7",
    async (variant) => {
      const instructions = `# ${variant} instructions\nPAPER research only.`;
      const prepared = preparedFor(variant, instructions);
      const invoke = vi.fn(async (_request: SelectedMarketSkillResearchRequest) => noTrade);
      const provider = createPreparedMarketResearchProvider(
        async () => prepared,
        createSelectedMarketSkillResearchRunner(invoke),
      );

      const result = await provider(payload, now);
      expect(result.signal).toMatchObject(noTrade);
      expect(result.executionAuthority).toBe("none");
      expect(result.provenance.skill?.variant).toBe(variant);
      const actualDigest = createHash("sha256").update(instructions).digest("hex");
      expect(resolvedTradingResearchApprovalScope(result)).toMatchObject({
        schemaVersion: "trading-resolved-research-scope-v2",
        skillVariant: variant,
        skillContentSha256: actualDigest,
      });
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({
        mode: "research_only",
        executionAuthority: "none",
        skill: {
          variant,
          instructions,
          sourceDigest: digest,
          contentSha256: createHash("sha256").update(instructions).digest("hex"),
        },
      });
    },
  );

  it("never silently falls back to original instructions when RCCL is missing", async () => {
    const prepared = preparedFor("rccl", "");
    const invoke = vi.fn(async (_request: SelectedMarketSkillResearchRequest) => noTrade);
    const provider = createPreparedMarketResearchProvider(
      async () => prepared,
      createSelectedMarketSkillResearchRunner(invoke),
    );
    await expect(provider(payload, now)).rejects.toThrow("content is missing");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a changed selected Skill variant before any research invocation", async () => {
    const prepared = preparedFor("rccl", "RCCL research-only instructions");
    if (prepared.selection.status !== "ready" || !prepared.selection.skill) {
      throw new Error("Invalid test fixture");
    }
    prepared.selection.skill.variant = "original";
    const invoke = vi.fn(async (_request: SelectedMarketSkillResearchRequest) => noTrade);
    const provider = createPreparedMarketResearchProvider(
      async () => prepared,
      createSelectedMarketSkillResearchRunner(invoke),
    );
    await expect(provider(payload, now)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not invoke a tool-only Resolver route as if it were an adapted Skill", async () => {
    const prepared = preparedFor("wrapped", "Read-only wrapped route");
    if (prepared.selection.status !== "ready") {
      throw new Error("Invalid test fixture");
    }
    prepared.selection.skill = null;
    prepared.provenance = { ...(prepared.provenance as object), skill: null };
    prepared.skillContent = null;
    const invoke = vi.fn(async (_request: SelectedMarketSkillResearchRequest) => noTrade);
    const provider = createPreparedMarketResearchProvider(
      async () => prepared,
      createSelectedMarketSkillResearchRunner(invoke),
    );
    await expect(provider(payload, now)).rejects.toThrow("requires pinned provenance");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects an execution-capable output even if the selected RCCL instructions were accepted", async () => {
    const prepared = preparedFor("rccl", "Analysis instructions");
    const provider = createPreparedMarketResearchProvider(
      async () => prepared,
      createSelectedMarketSkillResearchRunner(async () => ({
        ...noTrade,
        kind: "proposal",
        executionStatus: "live",
      })),
    );
    await expect(provider(payload, now)).rejects.toThrow();
  });
});
