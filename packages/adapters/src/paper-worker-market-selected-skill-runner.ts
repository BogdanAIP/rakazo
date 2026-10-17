import { createHash } from "node:crypto";
import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { TradingSignalSchema } from "@rakazo/contracts";
import type { PaperWorkerMarketResearchRunner } from "./paper-worker-market-prepared-provider.js";

type WorkerPayload = BackgroundJobPayloads["paper.worker-preflight"];
type SkillVariant = "original" | "rccl" | "wrapped" | "hybrid";

/**
 * The exact instructions and variant chosen by Market/prepare for ONE invocation.
 *
 * sourceDigest pins the original, immutable Market entry; contentSha256 pins
 * the actual original/adapted text handed to this researcher. Neither digest
 * is a grant of execution permission.
 */
export type SelectedMarketSkillResearchRequest = Readonly<{
  mode: "research_only";
  executionAuthority: "none";
  resolver: Readonly<{
    semanticKey: string;
    key: string;
    digest: string;
    implementationReference: string;
  }>;
  skill: Readonly<{
    entryId: string;
    key: string;
    sourceDigest: string;
    variant: SkillVariant;
    instructions: string;
    contentSha256: string;
  }>;
  requestedAt: string;
}>;

export type InvokeSelectedMarketSkillResearch = (
  request: SelectedMarketSkillResearchRequest,
  payload: WorkerPayload,
  now: Date,
) => Promise<unknown>;

const allowedVariants: readonly SkillVariant[] = ["original", "rccl", "wrapped", "hybrid"];

/**
 * Turns the Market-selected instruction variant into a concrete read-only
 * research invocation for the Trading G7 provider.
 *
 * Callers inject an explicitly authorized research invoker (e.g. an existing
 * read-only Market tool/LLM route). We do NOT interpret Skill text as code,
 * elevate it to system policy, install any Skill, grant connector scopes, or
 * call an exchange here. Absent a pinned Skill this runner fails closed; a
 * separate explicitly approved runner is needed for tool-only routes.
 */
export function createSelectedMarketSkillResearchRunner(
  invoke: InvokeSelectedMarketSkillResearch,
): PaperWorkerMarketResearchRunner {
  return async (prepared, payload, now) => {
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Invalid Market Skill research clock");
    }
    const selected = prepared.selection.skill;
    const pinned = prepared.provenance;
    if (!selected || !pinned || typeof pinned !== "object") {
      throw new Error("Selected Market Skill research requires pinned provenance");
    }
    if (!allowedVariants.includes(selected.variant as SkillVariant)) {
      throw new Error("Unsupported Market Skill variant");
    }
    const instructions = prepared.skillContent;
    if (!instructions?.trim()) {
      throw new Error("Selected Market Skill instructions are missing");
    }
    // G7 verifies the identity and provenance before invoking this runner.
    // Recheck the Skill association here to prevent accidental direct misuse.
    const skillProvenance = "skill" in pinned ? pinned.skill : null;
    if (
      !skillProvenance ||
      typeof skillProvenance !== "object" ||
      !("variant" in skillProvenance) ||
      skillProvenance.variant !== selected.variant ||
      !("sourceDigest" in skillProvenance) ||
      skillProvenance.sourceDigest !== selected.digest
    ) {
      throw new Error("Selected Skill variant does not match Market provenance");
    }

    const request: SelectedMarketSkillResearchRequest = {
      mode: "research_only",
      executionAuthority: "none",
      resolver: {
        semanticKey: prepared.selection.resolver.semanticKey,
        key: prepared.selection.resolver.key,
        digest: prepared.selection.resolver.digest,
        implementationReference: prepared.selection.implementation.reference,
      },
      skill: {
        entryId: selected.entryId,
        key: selected.key,
        sourceDigest: selected.digest,
        variant: selected.variant as SkillVariant,
        instructions,
        contentSha256: createHash("sha256").update(instructions, "utf8").digest("hex"),
      },
      requestedAt: now.toISOString(),
    };
    const result = await invoke(request, payload, now);
    return TradingSignalSchema.parse(result);
  };
}
