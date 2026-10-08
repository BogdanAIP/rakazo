import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import {
  type TradingResolvedResearchEnvelope,
  TradingResolvedResearchProvenanceSchema,
} from "@rakazo/contracts";
import { buildTradingResolvedResearchEnvelope } from "@rakazo/core";
import type { PaperWorkerResolvedResearchProvider } from "./paper-worker-resolved-research-flow.js";

type WorkerPayload = BackgroundJobPayloads["paper.worker-preflight"];

/**
 * Structural, adapter-neutral subset of MarketResolverPreparedResearch.
 * The Market service remains responsible for owner-scoped Resolver lookup,
 * deterministic selection, and pinned Skill content verification.
 */
type ReadySelection = {
  status: "ready";
  resolver: { semanticKey: string; key: string; digest: string };
  implementation: {
    name: string;
    kind: string;
    reference: string;
    priority: number;
    readOnly: boolean;
  };
  skill: {
    entryId: string;
    key: string;
    digest: string;
    variant: string;
  } | null;
};

// A single structural object matches MarketResolverPreparedResearch directly:
// Zod's cross-field refinements do not form a discriminated TS union.
export type PaperWorkerPreparedMarketResearch = {
  selection: { status: "deny" } | ReadySelection;
  provenance: unknown | null;
  skillContent: string | null;
};

export type PaperWorkerReadyMarketResearch = PaperWorkerPreparedMarketResearch & {
  selection: ReadySelection;
};

export type PaperWorkerMarketPrepare = (
  payload: WorkerPayload,
  now: Date,
) => Promise<PaperWorkerPreparedMarketResearch>;

export type PaperWorkerMarketResearchRunner = (
  prepared: PaperWorkerReadyMarketResearch,
  payload: WorkerPayload,
  now: Date,
) => Promise<unknown>;

/**
 * Market prepare/select -> read-only research runner -> Trading G6 envelope.
 *
 * The caller MUST supply a Market-owned, owner-scoped prepare function and an
 * already-authorized read-only research implementation runner. This adapter
 * NEVER discovers tools, installs Skills, executes arbitrary Skill instructions,
 * calls exchanges, authorizes PAPER state changes, or handles credentials.
 *
 * All provenance is checked against the selected Market route BEFORE invoking
 * the runner, so a missing/changed Resolver or Skill stops research fail-closed.
 * The runner's output must be a valid research-only TradingSignal. G1/G3 and
 * the PAPER transaction gates remain exclusively responsible for trading.
 */
export function createPreparedMarketResearchProvider(
  prepare: PaperWorkerMarketPrepare,
  runResearch: PaperWorkerMarketResearchRunner,
): PaperWorkerResolvedResearchProvider {
  return async (payload, now): Promise<TradingResolvedResearchEnvelope> => {
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Invalid prepared Market research clock");
    }

    const prepared = await prepare(payload, now);
    if (prepared.selection.status !== "ready") {
      throw new Error("Market Resolver denied read-only research preparation");
    }

    const { selection } = prepared;
    const provenance = TradingResolvedResearchProvenanceSchema.parse(prepared.provenance);
    const chosen = selection.implementation;
    const pinned = provenance.implementation;

    if (
      selection.resolver.semanticKey !== provenance.semanticKey ||
      selection.resolver.key !== provenance.resolverKey ||
      selection.resolver.digest !== provenance.resolverDigest ||
      chosen.name !== pinned.name ||
      chosen.kind !== pinned.kind ||
      chosen.reference !== pinned.reference ||
      chosen.priority !== pinned.priority ||
      chosen.readOnly !== true ||
      pinned.readOnly !== true
    ) {
      throw new Error("Market Resolver selection differs from pinned research provenance");
    }

    const skill = selection.skill;
    const pinnedSkill = provenance.skill;
    if ((skill === null) !== (pinnedSkill === null)) {
      throw new Error("Market Skill selection differs from pinned research provenance");
    }
    if (skill && pinnedSkill) {
      if (
        skill.entryId !== pinnedSkill.marketEntryId ||
        skill.key !== pinnedSkill.marketKey ||
        skill.digest !== pinnedSkill.sourceDigest ||
        skill.variant !== pinnedSkill.variant
      ) {
        throw new Error("Market Skill identity changed after research preparation");
      }
    }
    if (skill && !prepared.skillContent?.trim()) {
      throw new Error("Pinned Market Skill content is missing");
    }
    if (!skill && prepared.skillContent !== null) {
      throw new Error("Unpinned Market Skill content cannot be executed");
    }

    const ready: PaperWorkerReadyMarketResearch = { ...prepared, selection };
    const signal = await runResearch(ready, payload, now);
    return buildTradingResolvedResearchEnvelope(provenance, signal);
  };
}
