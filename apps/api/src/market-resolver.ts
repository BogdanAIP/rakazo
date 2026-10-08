import {
  type CapabilityTool,
  type MarketResolverBinding,
  MarketResolverContentSchema,
} from "@rakazo/contracts";

export type ResolverAccess = "read" | "interactive";
export type AuthorizedNativeRoute = {
  procedure: string;
  readOnly: boolean;
};
export type ResolverCandidate = {
  reference: string;
  priority: number;
  status: "eligible" | "missing_binding" | "not_authorized" | "access_denied" | "ambiguous";
  reason: string;
};
export type ResolverDecision = {
  status: "selected" | "unavailable" | "invalid";
  semanticKey: string;
  selected: null | {
    reference: string;
    priority: number;
    binding: MarketResolverBinding;
    readOnly: boolean;
  };
  candidates: ResolverCandidate[];
  reason: string;
};

const sameConnector = (
  tool: Pick<CapabilityTool, "name" | "readOnly" | "route">,
  binding: Extract<MarketResolverBinding, { type: "connector" }>,
): boolean =>
  tool.name === binding.tool &&
  tool.route.connectorId === binding.connectorId &&
  tool.route.toolName === binding.toolName &&
  (tool.route.resourceId ?? null) === (binding.resourceId ?? null) &&
  String(tool.route.resourceRevision ?? "") === String(binding.resourceRevision ?? "") &&
  (tool.route.catalogGroup ?? null) === (binding.catalogGroup ?? null);

/** Select only a route already verified by the existing authorization layers.
 * This function never executes tools, installs dependencies or grants access.
 * New semantic keys and providers require data-only bindings, not new cases here.
 */
export function resolveMarketRoute(input: {
  semanticKey: string;
  content: unknown;
  access: ResolverAccess;
  capabilities: Array<Pick<CapabilityTool, "name" | "readOnly" | "route">>;
  nativeRoutes: AuthorizedNativeRoute[];
}): ResolverDecision {
  const base = {
    semanticKey: input.semanticKey,
    selected: null,
    candidates: [] as ResolverCandidate[],
  };
  const parsed = MarketResolverContentSchema.safeParse(input.content);
  if (!parsed.success || parsed.data.semanticKey !== input.semanticKey) {
    return { ...base, status: "invalid", reason: "Resolver schema or semantic key mismatch" };
  }
  const implementations = [...parsed.data.implementations].sort(
    (a, b) => a.priority - b.priority || a.reference.localeCompare(b.reference),
  );
  const priorities = implementations.map((candidate) => candidate.priority);
  if (new Set(priorities).size !== priorities.length) {
    return { ...base, status: "invalid", reason: "Duplicate Resolver priorities" };
  }
  const bindingKeys = implementations
    .filter((candidate) => candidate.binding)
    .map((candidate) => JSON.stringify(candidate.binding));
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    return { ...base, status: "invalid", reason: "Duplicate executable bindings" };
  }
  const eligible: Array<NonNullable<ResolverDecision["selected"]>> = [];
  for (const candidate of implementations) {
    const binding = candidate.binding;
    const result: ResolverCandidate = {
      reference: candidate.reference,
      priority: candidate.priority,
      status: "missing_binding",
      reason: "No explicit executable binding; index entry is documentation only",
    };
    if (binding?.type === "appContract" && candidate.reference !== "rakazo:" + binding.procedure) {
      result.status = "not_authorized";
      result.reason = "Native binding disagrees with declared implementation identity";
      base.candidates.push(result);
      continue;
    }
    if (!binding) {
      base.candidates.push(result);
      continue;
    }
    let found: boolean;
    let readOnly = false;
    if (binding.type === "appContract") {
      const matches = input.nativeRoutes.filter((route) => route.procedure === binding.procedure);
      found = matches.length === 1;
      if (matches.length > 1) {
        result.status = "ambiguous";
        result.reason = "Ambiguous native route";
        base.candidates.push(result);
        continue;
      }
      readOnly = matches[0]?.readOnly === true;
    } else {
      const matches = input.capabilities.filter((tool) => sameConnector(tool, binding));
      found = matches.length === 1;
      if (matches.length > 1) {
        result.status = "ambiguous";
        result.reason = "Ambiguous authorized connector route";
        base.candidates.push(result);
        continue;
      }
      readOnly = matches[0]?.readOnly === true;
    }
    if (!found) {
      result.status = "not_authorized";
      result.reason = "No matching route in the current authorized capability set";
    } else if (input.access === "read" && (!readOnly || candidate.readOnly !== true)) {
      result.status = "access_denied";
      result.reason = "Read-only request cannot select a write-capable implementation";
    } else if (candidate.readOnly === true && !readOnly) {
      result.status = "access_denied";
      result.reason = "Provider is less restricted than declared Resolver binding";
    } else {
      result.status = "eligible";
      result.reason = "Explicit binding matches a currently authorized route";
      eligible.push({
        reference: candidate.reference,
        priority: candidate.priority,
        binding,
        readOnly,
      });
    }
    base.candidates.push(result);
  }
  const selected = eligible[0];
  if (selected) {
    return {
      ...base,
      status: "selected",
      selected,
      reason: "Lowest-priority-number eligible binding; execution must reauthorize",
    };
  }
  return { ...base, status: "unavailable", reason: "No eligible authorized route" };
}
