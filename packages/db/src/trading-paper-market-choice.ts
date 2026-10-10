import { createHash } from "node:crypto";
import type { MarketResolverPreparedResearch } from "@rakazo/contracts";
import { TradingResolvedResearchApprovalScopeSchema } from "@rakazo/contracts";
export function tradingPaperMarketScope(
  prepared: MarketResolverPreparedResearch,
  venue: "okx" | "bingx",
) {
  const { selection, provenance, skillContent } = prepared;
  if (selection.status !== "ready" || !selection.skill || !provenance || !skillContent?.trim())
    throw new Error("PAPER Market Skill unavailable");
  return TradingResolvedResearchApprovalScopeSchema.parse({
    schemaVersion: "trading-resolved-research-scope-v2",
    semanticKey: provenance.semanticKey,
    resolverKey: provenance.resolverKey,
    resolverDigest: provenance.resolverDigest,
    implementationReference: provenance.implementation.reference,
    skillSourceDigest: selection.skill.digest,
    skillVariant: selection.skill.variant,
    skillContentSha256: createHash("sha256").update(skillContent, "utf8").digest("hex"),
    strategyId: `market:${createHash("sha256").update(selection.skill.key, "utf8").digest("hex")}`,
    strategyVersion: "1",
    venue,
    marketKind: "spot",
    action: "spot_buy",
  });
}
