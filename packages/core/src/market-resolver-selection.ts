import {
  type MarketEntry,
  MarketEntrySchema,
  type MarketResolverImplementation,
  MarketResolverContentSchema,
  type MarketResolverPinnedResearchProvenance,
  MarketResolverPinnedResearchProvenanceSchema,
  MarketResolverPlanSchema,
  type MarketResolverPreparedResearch,
  MarketResolverPreparedResearchSchema,
  type MarketResolverReadOnlySelection,
  MarketResolverReadOnlySelectionSchema,
  type MarketResolverSelectionSkip,
} from "@rakazo/contracts";

export type {
  MarketResolverReadOnlySelection,
  MarketResolverSelectionSkip,
  MarketResolverSelectionSkipReason,
} from "@rakazo/contracts";

export class MarketResolverSelectionIntegrityError extends Error {
  constructor(message = "Market Resolver selection plan integrity mismatch") {
    super(message);
    this.name = "MarketResolverSelectionIntegrityError";
  }
}
export type MarketResolverPlanResolutionErrorCode =
  | "resolver_not_found"
  | "resolver_ambiguous"
  | "resolver_digest_changed";

export class MarketResolverPlanResolutionError extends Error {
  constructor(
    readonly code: MarketResolverPlanResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketResolverPlanResolutionError";
  }
}

export type MarketResolverPlanRequest = {
  semanticKey: string;
  resolverKey?: string;
  expectedDigest?: string;
  requireReadOnly: boolean;
  allowedKinds?: Array<MarketResolverImplementation["kind"]>;
  limit: number;
};

function parseMarketSkillReference(
  reference: string,
): { repository: string; name: string } | null {
  if (!reference.startsWith("market:")) return null;
  const body = reference.slice("market:".length);
  const separator = body.lastIndexOf(":");
  if (separator <= 0 || separator === body.length - 1) return null;
  const repository = body.slice(0, separator);
  const name = body.slice(separator + 1);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    ? { repository, name }
    : null;
}

function resolveMarketSkillLinkFromEntries(
  reference: string,
  skillEntries: MarketEntry[],
) {
  const target = parseMarketSkillReference(reference);
  if (!target) return null;
  const matches = skillEntries.filter(
    (entry) =>
      entry.kind === "skill" &&
      entry.repository === target.repository &&
      entry.name === target.name,
  );
  if (matches.length === 0) return { status: "missing" as const };
  if (matches.length > 1) {
    return { status: "ambiguous" as const, matches: matches.length };
  }
  const entry = matches[0]!;
  return {
    status: "resolved" as const,
    entryId: entry.id,
    key: entry.key,
    name: entry.name,
    repository: entry.repository,
    digest: entry.digest,
    variant: entry.preferredVariant,
    tags: entry.tags,
  };
}

/**
 * Builds the deterministic Resolver plan from already owner-scoped Market
 * entries. Storage/auth stay outside this pure function so API, workers and
 * future Project runtimes can share exactly one planning implementation.
 */
export function resolveMarketResolverPlanFromEntries(
  resolverEntriesInput: unknown[],
  skillEntriesInput: unknown[],
  input: MarketResolverPlanRequest,
) {
  const resolverEntries = resolverEntriesInput.map((entry) => MarketEntrySchema.parse(entry));
  const skillEntries = skillEntriesInput.map((entry) => MarketEntrySchema.parse(entry));
  const matches = resolverEntries.flatMap((entry) => {
    if (entry.kind !== "resolver") return [];
    let raw: unknown;
    try {
      raw = JSON.parse(entry.originalContent);
    } catch {
      return [];
    }
    const parsed = MarketResolverContentSchema.safeParse(raw);
    return parsed.success && parsed.data.semanticKey === input.semanticKey
      ? [{ entry, content: parsed.data }]
      : [];
  });
  const pinned = input.resolverKey
    ? matches.filter(({ entry }) => entry.key === input.resolverKey)
    : matches;
  if (pinned.length === 0) {
    throw new MarketResolverPlanResolutionError(
      "resolver_not_found",
      "No Market Resolver matches the requested semantic key.",
    );
  }

  let selected = pinned[0]!;
  if (!input.resolverKey && pinned.length > 1) {
    const exact = pinned.filter(({ entry }) => entry.key === input.semanticKey);
    if (exact.length !== 1) {
      throw new MarketResolverPlanResolutionError(
        "resolver_ambiguous",
        "Multiple Market Resolvers match this semantic key; pin resolverKey.",
      );
    }
    selected = exact[0]!;
  }
  if (input.expectedDigest && selected.entry.digest !== input.expectedDigest) {
    throw new MarketResolverPlanResolutionError(
      "resolver_digest_changed",
      "Market Resolver digest changed.",
    );
  }

  const allowedKinds = input.allowedKinds ? new Set(input.allowedKinds) : null;
  const candidates = selected.content.implementations
    .filter((implementation) => !input.requireReadOnly || implementation.readOnly === true)
    .filter((implementation) => !allowedKinds || allowedKinds.has(implementation.kind))
    .map(
      (implementation): MarketResolverImplementation => ({
        name: implementation.name,
        kind: implementation.kind,
        reference: implementation.reference,
        skillReference: implementation.skillReference ?? null,
        priority: implementation.priority,
        readOnly: implementation.readOnly === true,
        constraints: implementation.constraints,
        ...(implementation.notes ? { notes: implementation.notes } : {}),
        skill: resolveMarketSkillLinkFromEntries(
          implementation.skillReference ?? implementation.reference,
          skillEntries,
        ),
      }),
    )
    .sort(compareImplementations)
    .slice(0, input.limit);

  return MarketResolverPlanSchema.parse({
    resolver: {
      entryId: selected.entry.id,
      key: selected.entry.key,
      digest: selected.entry.digest,
      semanticKey: selected.content.semanticKey,
    },
    preferred: candidates[0] ?? null,
    candidates,
  });
}

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
    return MarketResolverReadOnlySelectionSchema.parse({
      status: "deny",
      resolver: plan.resolver,
      reason: "no_eligible_read_only_implementation",
      skipped: [],
    });
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
    return MarketResolverReadOnlySelectionSchema.parse({
      status: "ready",
      resolver: plan.resolver,
      implementation: { ...implementation, readOnly: true },
      skill: skill?.status === "resolved" ? skill : null,
      skipped,
    });
  }

  return MarketResolverReadOnlySelectionSchema.parse({
    status: "deny",
    resolver: plan.resolver,
    reason: "no_eligible_read_only_implementation",
    skipped,
  });
}

/**
 * Pins one already-selected read-only Resolver route into the minimal immutable
 * research provenance later consumed by domain-specific research adapters.
 * This never invokes the implementation or Skill and grants no PAPER/live
 * execution authority.
 */
export type MarketResolverPinnedSkillContent = {
  entry: MarketEntry;
  content: string;
  variant: "original" | "rccl" | "wrapped" | "hybrid";
};

/**
 * Reads the exact Market Skill content pinned by one ready Resolver selection
 * without installing it into the owner-wide Agent Skill catalog.
 *
 * This is a pure provenance check. It neither invokes the Skill nor grants
 * PAPER/live execution authority. A stale entry id/key/digest/name/repository
 * or changed preferred variant fails closed.
 */
export function readPinnedMarketResolverSkillContent(
  selectionInput: unknown,
  entryInput: unknown,
): MarketResolverPinnedSkillContent {
  const selection = MarketResolverReadOnlySelectionSchema.parse(selectionInput);
  if (selection.status !== "ready" || !selection.skill) {
    throw new MarketResolverSelectionIntegrityError(
      "Resolver selection does not pin a Market Skill",
    );
  }
  const entry = MarketEntrySchema.parse(entryInput);
  const selected = selection.skill;
  if (
    entry.kind !== "skill" ||
    entry.id !== selected.entryId ||
    entry.key !== selected.key ||
    entry.name !== selected.name ||
    entry.repository !== selected.repository ||
    entry.digest !== selected.digest ||
    entry.preferredVariant !== selected.variant
  ) {
    throw new MarketResolverSelectionIntegrityError(
      "Market Skill entry changed after Resolver selection",
    );
  }

  const content =
    selected.variant === "original"
      ? entry.originalContent
      : entry.adaptationMode === selected.variant
        ? entry.adaptedContent
        : null;
  if (!content) {
    throw new MarketResolverSelectionIntegrityError(
      "Pinned Market Skill variant content is unavailable",
    );
  }
  return { entry, content, variant: selected.variant };
}

export function prepareMarketResolverResearch(
  selectionInput: unknown,
  entryInput: unknown | undefined,
  resolvedAt: string,
): MarketResolverPreparedResearch {
  const selection = MarketResolverReadOnlySelectionSchema.parse(selectionInput);
  if (selection.status === "deny") {
    return MarketResolverPreparedResearchSchema.parse({
      selection,
      provenance: null,
      skillContent: null,
    });
  }

  const provenance = pinMarketResolverResearchProvenance(selection, resolvedAt);
  const skillContent =
    selection.skill === null
      ? null
      : readPinnedMarketResolverSkillContent(selection, entryInput).content;
  return MarketResolverPreparedResearchSchema.parse({
    selection,
    provenance,
    skillContent,
  });
}

export function pinMarketResolverResearchProvenance(
  input: unknown,
  resolvedAt: string,
): MarketResolverPinnedResearchProvenance {
  const selection = MarketResolverReadOnlySelectionSchema.parse(input);
  if (selection.status !== "ready") {
    throw new MarketResolverSelectionIntegrityError(
      "Denied Resolver selection cannot produce research provenance",
    );
  }
  return MarketResolverPinnedResearchProvenanceSchema.parse({
    semanticKey: selection.resolver.semanticKey,
    resolverKey: selection.resolver.key,
    resolverDigest: selection.resolver.digest,
    implementation: {
      name: selection.implementation.name,
      kind: selection.implementation.kind,
      reference: selection.implementation.reference,
      priority: selection.implementation.priority,
      readOnly: true,
    },
    skill: selection.skill
      ? {
          marketEntryId: selection.skill.entryId,
          marketKey: selection.skill.key,
          sourceDigest: selection.skill.digest,
          variant: selection.skill.variant,
        }
      : null,
    resolvedAt,
  });
}
