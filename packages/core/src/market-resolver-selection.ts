import {
  type MarketResolverImplementation,
  type MarketResolverPlan,
  MarketResolverPlanSchema,
  type MarketResolverSkillLink,
} from "@rakazo/contracts";

export class MarketResolverSelectionIntegrityError extends Error {
  constructor(message = "Market Resolver selection plan integrity mismatch") {
    super(message);
    this.name = "MarketResolverSelectionIntegrityError";
  }
}

export type MarketResolverSelectionSkipReason =
  | "implementation_not_read_only"
  | "market_skill_missing"
  | "market_skill_ambiguous";

export type MarketResolverSelectionSkip = {
  name: string;
  reference: string;
  priority: number;
  reason: MarketResolverSelectionSkipReason;
  matches?: number;
};

export type MarketResolverReadOnlySelection =
  | {
      status: "ready";
      resolver: MarketResolverPlan["resolver"];
      implementation: Omit<MarketResolverImplementation, "skill"> & { readOnly: true };
      skill: Extract<MarketResolverSkillLink, { status: "resolved" }> | null;
      skipped: MarketResolverSelectionSkip[];
    }
  | {
      status: "deny";
      resolver: MarketResolverPlan["resolver"];
      reason: "no_eligible_read_only_implementation";
      skipped: MarketResolverSelectionSkip[];
    };

function compareImplementations(
  left: MarketResolverImplementation,
  right: MarketResolverImplementation,
): number {
  return (
    left.priority - right.priority ||
    left.name.localeCompare(right.name) ||
    left.reference.localeCompare(right.reference)
  );
}

function sameImplementation(
  left: MarketResolverImplementation,
  right: MarketResolverImplementation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiresMarketSkill(implementation: MarketResolverImplementation): boolean {
  return (implementation.skillReference ?? implementation.reference).startsWith("market:");
}

/**
 * Converts a data-only Market Resolver plan into one deterministic read-only
 * implementation selection suitable for a later research adapter.
 *
 * Resolver order is preserved, but Market-backed routes are eligible only when
 * the plan carries an exact resolved Skill entry id/key/digest/variant. Missing
 * or ambiguous Skill links are skipped rather than guessed. This function does
 * not install or invoke a Skill and grants no PAPER/live execution authority.
 */
export function selectMarketResolverReadOnlyImplementation(
  input: unknown,
): MarketResolverReadOnlySelection {
  const plan = MarketResolverPlanSchema.parse(input);
  const candidates = [...plan.candidates].sort(compareImplementations);

  if (candidates.length === 0) {
    if (plan.preferred !== null) {
      throw new MarketResolverSelectionIntegrityError(
        "Resolver plan has a preferred implementation without candidates",
      );
    }
    return {
      status: "deny",
      resolver: plan.resolver,
      reason: "no_eligible_read_only_implementation",
      skipped: [],
    };
  }

  if (!plan.preferred || !sameImplementation(plan.preferred, candidates[0]!)) {
    throw new MarketResolverSelectionIntegrityError(
      "Resolver preferred implementation disagrees with deterministic candidate order",
    );
  }

  const skipped: MarketResolverSelectionSkip[] = [];
  for (const candidate of candidates) {
    if (!candidate.readOnly) {
      skipped.push({
        name: candidate.name,
        reference: candidate.reference,
        priority: candidate.priority,
        reason: "implementation_not_read_only",
      });
      continue;
    }

    const marketSkillRequired = requiresMarketSkill(candidate);
    if (marketSkillRequired) {
      if (!candidate.skill || candidate.skill.status === "missing") {
        skipped.push({
          name: candidate.name,
          reference: candidate.reference,
          priority: candidate.priority,
          reason: "market_skill_missing",
        });
        continue;
      }
      if (candidate.skill.status === "ambiguous") {
        skipped.push({
          name: candidate.name,
          reference: candidate.reference,
          priority: candidate.priority,
          reason: "market_skill_ambiguous",
          matches: candidate.skill.matches,
        });
        continue;
      }
    } else if (candidate.skill !== null) {
      throw new MarketResolverSelectionIntegrityError(
        "Non-Market Resolver implementation unexpectedly carries Market Skill provenance",
      );
    }

    const { skill, ...implementation } = candidate;
    return {
      status: "ready",
      resolver: plan.resolver,
      implementation: { ...implementation, readOnly: true },
      skill: skill?.status === "resolved" ? skill : null,
      skipped,
    };
  }

  return {
    status: "deny",
    resolver: plan.resolver,
    reason: "no_eligible_read_only_implementation",
    skipped,
  };
}
