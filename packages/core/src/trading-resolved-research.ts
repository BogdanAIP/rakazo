import {
  type TradingResolvedResearchApprovalScope,
  TradingResolvedResearchApprovalScopeSchema,
  type TradingResolvedResearchEnvelope,
  TradingResolvedResearchEnvelopeSchema,
  type TradingSignal,
} from "@rakazo/contracts";

/**
 * Trading-side half of the Market Resolver bridge.
 *
 * Accepts only data-only pinned provenance plus a research signal and validates
 * the complete Trading envelope. Market-native keys that exceed Trading's
 * narrower contract, non-read-only implementations, malformed Skill digests or
 * executable signals fail closed instead of being truncated or coerced.
 */
export function buildTradingResolvedResearchEnvelope(
  provenance: unknown,
  signal: unknown,
): TradingResolvedResearchEnvelope {
  return TradingResolvedResearchEnvelopeSchema.parse({
    schemaVersion: "trading-resolved-research-v1",
    mode: "research_only",
    executionAuthority: "none",
    provenance,
    signal,
  });
}

export type ResolvedTradingResearchAssessment =
  | {
      status: "no_trade";
      envelope: TradingResolvedResearchEnvelope;
      scope: TradingResolvedResearchApprovalScope;
      signal: Extract<TradingSignal, { kind: "no_trade" }>;
    }
  | {
      status: "expired";
      envelope: TradingResolvedResearchEnvelope;
      scope: TradingResolvedResearchApprovalScope;
      signal: Extract<TradingSignal, { kind: "proposal" }>;
    }
  | {
      status: "proposal";
      envelope: TradingResolvedResearchEnvelope;
      scope: TradingResolvedResearchApprovalScope;
      signal: Extract<TradingSignal, { kind: "proposal" }>;
    };

export function resolvedTradingResearchApprovalScope(
  input: TradingResolvedResearchEnvelope,
): TradingResolvedResearchApprovalScope {
  const envelope = TradingResolvedResearchEnvelopeSchema.parse(input);
  const skill = envelope.provenance.skill;
  // V1 remains recognizable only for historical original-Skill/tool-only research.
  // Adapted Skills without a verified selected-text digest cannot reach G1/G3.
  if (skill && skill.variant !== "original" && !skill.contentSha256) {
    throw new Error("Adapted Market Skill lacks pinned instruction content digest");
  }
  const boundSkill = skill?.contentSha256
    ? {
        schemaVersion: "trading-resolved-research-scope-v2" as const,
        skillVariant: skill.variant,
        skillContentSha256: skill.contentSha256,
      }
    : { schemaVersion: "trading-resolved-research-scope-v1" as const };
  return TradingResolvedResearchApprovalScopeSchema.parse({
    ...boundSkill,
    semanticKey: envelope.provenance.semanticKey,
    resolverKey: envelope.provenance.resolverKey,
    resolverDigest: envelope.provenance.resolverDigest,
    implementationReference: envelope.provenance.implementation.reference,
    skillSourceDigest: skill?.sourceDigest ?? null,
    strategyId: envelope.signal.strategyId,
    strategyVersion: envelope.signal.strategyVersion,
    venue: envelope.signal.kind === "proposal" ? envelope.signal.market.venue : null,
    marketKind: envelope.signal.kind === "proposal" ? envelope.signal.market.kind : null,
    action: envelope.signal.kind === "proposal" ? envelope.signal.action : null,
  });
}

/**
 * Read-only validation boundary before any future generic PAPER approval gate.
 *
 * Market Resolver/Skill provenance is normalized first, then the signal clock
 * is checked. This function never reserves, fills, closes or grants execution
 * authority.
 */
export function assessResolvedTradingResearch(
  input: unknown,
  now: Date = new Date(),
): ResolvedTradingResearchAssessment {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid resolved trading research clock");
  }
  const envelope = TradingResolvedResearchEnvelopeSchema.parse(input);
  const scope = resolvedTradingResearchApprovalScope(envelope);
  if (envelope.signal.kind === "no_trade") {
    return { status: "no_trade", envelope, scope, signal: envelope.signal };
  }
  if (Date.parse(envelope.signal.expiresAt) <= now.getTime()) {
    return { status: "expired", envelope, scope, signal: envelope.signal };
  }
  return { status: "proposal", envelope, scope, signal: envelope.signal };
}
