import { TradingResolvedResearchApprovalScopeSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builtinAgentTools } from "./builtin-tools.js";

describe("Market Resolver explicit-approval tool schemas", () => {
  it.each(["paper_resolved_research_control", "paper_resolved_research_fill_control"])(
    "%s uses the canonical contract, including v2 selected Skill identity",
    (name) => {
      const tool = builtinAgentTools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      const schema = tool?.inputSchema as {
        oneOf?: Array<{ properties?: { scope?: unknown } }>;
      };
      expect(schema.oneOf?.[0]?.properties?.scope).toEqual(
        z.toJSONSchema(TradingResolvedResearchApprovalScopeSchema),
      );
    },
  );

  it("accepts the pinned v2 Market Skill while preserving v1 replay compatibility", () => {
    const common = {
      semanticKey: "market.public-ohlcv",
      resolverKey: "market-public-candles",
      resolverDigest: "a".repeat(64),
      implementationReference: "public-market://okx",
      skillSourceDigest: "b".repeat(64),
      strategyId: "breakout_20_1h_v1",
      strategyVersion: "1",
      venue: "okx",
      marketKind: "spot",
      action: "spot_buy",
    };
    const v2 = {
      ...common,
      schemaVersion: "trading-resolved-research-scope-v2",
      skillVariant: "rccl",
      skillContentSha256: "c".repeat(64),
    };
    expect(TradingResolvedResearchApprovalScopeSchema.safeParse(v2).success).toBe(true);
    expect(
      TradingResolvedResearchApprovalScopeSchema.safeParse({
        ...common,
        schemaVersion: "trading-resolved-research-scope-v1",
      }).success,
    ).toBe(true);
    expect(
      TradingResolvedResearchApprovalScopeSchema.safeParse({
        ...v2,
        skillContentSha256: undefined,
      }).success,
    ).toBe(false);
  });
});
