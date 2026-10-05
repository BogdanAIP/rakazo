export const CAPABILITY_PROFILE_SCHEMA_VERSION = "capability-profile-v1" as const;
export const CAPABILITY_BINDING_SCHEMA_VERSION = "capability-binding-v1" as const;

export const SEMANTIC_CAPABILITY_REQUIREMENT_NAMES = [
  "repo.read",
  "repo.write",
  "browser.semantic",
  "browser.debug",
  "browser.visual",
  "computer.exec",
  "computer.files",
  "research.web",
  "documents.read",
  "citations",
  "media.capture",
  "messaging.telegram",
  "market.data",
  "defi.data",
  "database.read",
] as const;

export type SemanticCapabilityRequirement =
  (typeof SEMANTIC_CAPABILITY_REQUIREMENT_NAMES)[number];

export const SEMANTIC_CAPABILITY_REQUIREMENTS: Record<
  SemanticCapabilityRequirement,
  {
    description: string;
    discoveryQuery: string;
    class: "project" | "computer" | "external";
  }
> = {
  "repo.read": {
    description: "Read the Project source repository and repository metadata.",
    discoveryQuery: "repository source control read",
    class: "project",
  },
  "repo.write": {
    description: "Write to the exact Project repository under existing Project policy.",
    discoveryQuery: "repository source control write",
    class: "project",
  },
  "browser.semantic": {
    description: "Inspect and operate a web page through a structured semantic DOM/accessibility surface.",
    discoveryQuery: "browser playwright accessibility semantic",
    class: "external",
  },
  "browser.debug": {
    description: "Inspect browser console, network, DOM and performance/debug state.",
    discoveryQuery: "browser devtools console network debug",
    class: "external",
  },
  "browser.visual": {
    description: "Observe a browser or desktop visually through the Project execution computer.",
    discoveryQuery: "browser screenshot visual",
    class: "computer",
  },
  "computer.exec": {
    description: "Run bounded commands on a Project execution computer under normal control policy.",
    discoveryQuery: "computer terminal command execution",
    class: "computer",
  },
  "computer.files": {
    description: "Read or transfer files through a Project execution computer.",
    discoveryQuery: "computer filesystem files",
    class: "computer",
  },
  "research.web": {
    description: "Search and inspect external research/web sources.",
    discoveryQuery: "web research search",
    class: "external",
  },
  "documents.read": {
    description: "Read and extract structured content from Project documents.",
    discoveryQuery: "pdf docx xlsx document reader extraction",
    class: "external",
  },
  citations: {
    description: "Return source provenance/citations for research outputs.",
    discoveryQuery: "citations sources research",
    class: "external",
  },
  "media.capture": {
    description: "Capture screenshots or short screen recordings for Project media workflows.",
    discoveryQuery: "screenshot screen recording media capture",
    class: "external",
  },
  "messaging.telegram": {
    description: "Read or deliver Project-scoped Telegram content through an authorized connector.",
    discoveryQuery: "telegram messaging",
    class: "external",
  },
  "market.data": {
    description: "Read current market data for analysis.",
    discoveryQuery: "market price orderbook trading data",
    class: "external",
  },
  "defi.data": {
    description: "Read DeFi protocol/on-chain data for analysis.",
    discoveryQuery: "defi onchain protocol data",
    class: "external",
  },
  "database.read": {
    description: "Read Project-approved database data without mutation.",
    discoveryQuery: "database sql read only",
    class: "external",
  },
} as const;

export type CapabilityProfileDefinition = {
  slug: string;
  name: string;
  description: string;
  required: SemanticCapabilityRequirement[];
  optional: SemanticCapabilityRequirement[];
  denied: SemanticCapabilityRequirement[];
};

export const BUILTIN_CAPABILITY_PROFILES: readonly CapabilityProfileDefinition[] = [
  {
    slug: "web-development",
    name: "Web development",
    description: "Repository-centered web application development with optional browser diagnostics.",
    required: ["repo.read"],
    optional: [
      "repo.write",
      "computer.files",
      "computer.exec",
      "browser.semantic",
      "browser.debug",
      "browser.visual",
    ],
    denied: [],
  },
  {
    slug: "research",
    name: "Research",
    description: "Source-grounded research and document analysis.",
    required: ["research.web", "citations"],
    optional: ["documents.read", "browser.semantic", "browser.visual"],
    denied: ["repo.write"],
  },
  {
    slug: "aihot",
    name: "AIHOT",
    description: "AI news development, research, browser investigation and media preparation.",
    required: ["repo.read", "research.web"],
    optional: [
      "repo.write",
      "browser.semantic",
      "browser.debug",
      "browser.visual",
      "computer.files",
      "computer.exec",
      "media.capture",
      "messaging.telegram",
      "citations",
    ],
    denied: [],
  },
  {
    slug: "trading-research",
    name: "Trading research",
    description: "PAPER-only trading research and data analysis.",
    required: ["repo.read", "market.data"],
    optional: ["repo.write", "research.web", "defi.data", "database.read", "citations"],
    denied: ["messaging.telegram"],
  },
] as const;

export type CapabilityProfileSnapshot = {
  schemaVersion: typeof CAPABILITY_PROFILE_SCHEMA_VERSION;
  catalogVersion: 1;
  profile: string;
  required: SemanticCapabilityRequirement[];
  optional: SemanticCapabilityRequirement[];
  denied: SemanticCapabilityRequirement[];
};

export type CapabilityBindingSnapshot = {
  schemaVersion: typeof CAPABILITY_BINDING_SCHEMA_VERSION;
  requirement: SemanticCapabilityRequirement;
  botId: string;
  tool: string;
  route: {
    connectorId: string;
    toolName: string;
    resourceId?: string;
    resourceRevision?: string | number;
    catalogGroup?: string;
  };
};

export type ProjectResourceLike = {
  id?: unknown;
  kind?: unknown;
  ref?: unknown;
  label?: unknown;
  metadata?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueRequirements(
  values: readonly SemanticCapabilityRequirement[],
): SemanticCapabilityRequirement[] {
  return [...new Set(values)];
}

export function isSemanticCapabilityRequirement(
  value: unknown,
): value is SemanticCapabilityRequirement {
  return typeof value === "string" && value in SEMANTIC_CAPABILITY_REQUIREMENTS;
}

function requirements(value: unknown): SemanticCapabilityRequirement[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: SemanticCapabilityRequirement[] = [];
  for (const item of value) {
    if (!isSemanticCapabilityRequirement(item)) return null;
    parsed.push(item);
  }
  return uniqueRequirements(parsed);
}

export function getBuiltinCapabilityProfile(
  slug: string,
): CapabilityProfileDefinition | undefined {
  return BUILTIN_CAPABILITY_PROFILES.find((profile) => profile.slug === slug.trim());
}

export function materializeCapabilityProfile(input: {
  profile: string;
  addRequired?: SemanticCapabilityRequirement[];
  addOptional?: SemanticCapabilityRequirement[];
  deny?: SemanticCapabilityRequirement[];
}): CapabilityProfileSnapshot {
  const base = getBuiltinCapabilityProfile(input.profile);
  if (!base) throw new Error("Unknown capability profile: " + input.profile);

  const denied = uniqueRequirements([...base.denied, ...(input.deny ?? [])]);
  const deniedSet = new Set(denied);
  const required = uniqueRequirements([...base.required, ...(input.addRequired ?? [])]).filter(
    (requirement) => !deniedSet.has(requirement),
  );
  const requiredSet = new Set(required);
  const optional = uniqueRequirements([...base.optional, ...(input.addOptional ?? [])]).filter(
    (requirement) => !deniedSet.has(requirement) && !requiredSet.has(requirement),
  );

  return {
    schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
    catalogVersion: 1,
    profile: base.slug,
    required,
    optional,
    denied,
  };
}

export function parseCapabilityProfileResource(
  resource: ProjectResourceLike,
): { snapshot: CapabilityProfileSnapshot } | { error: string } | null {
  if (text(resource.kind) !== "capability.profile" || text(resource.ref) !== "active") return null;
  const metadata = record(resource.metadata);
  if (metadata.schemaVersion !== CAPABILITY_PROFILE_SCHEMA_VERSION) {
    return { error: "capability.profile active resource has an unsupported schemaVersion." };
  }
  if (metadata.catalogVersion !== 1) {
    return { error: "capability.profile active resource has an unsupported catalogVersion." };
  }
  const profile = text(metadata.profile);
  if (!profile) return { error: "capability.profile active resource requires profile." };
  const required = requirements(metadata.required);
  const optional = requirements(metadata.optional);
  const denied = requirements(metadata.denied);
  if (!required || !optional || !denied) {
    return { error: "capability.profile requirements contain an unknown semantic capability." };
  }
  const deniedSet = new Set(denied);
  if (required.some((item) => deniedSet.has(item))) {
    return { error: "capability.profile cannot both require and deny the same capability." };
  }
  const requiredSet = new Set(required);
  if (optional.some((item) => requiredSet.has(item) || deniedSet.has(item))) {
    return { error: "capability.profile optional capabilities must not duplicate required/denied." };
  }
  return {
    snapshot: {
      schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
      catalogVersion: 1,
      profile,
      required,
      optional,
      denied,
    },
  };
}

export function parseCapabilityBindingResource(
  resource: ProjectResourceLike,
): { binding: CapabilityBindingSnapshot } | { error: string } | null {
  if (text(resource.kind) !== "capability.binding") return null;
  const requirement = text(resource.ref);
  if (!isSemanticCapabilityRequirement(requirement)) {
    return { error: "capability.binding ref must be a known semantic capability." };
  }
  const metadata = record(resource.metadata);
  if (metadata.schemaVersion !== CAPABILITY_BINDING_SCHEMA_VERSION) {
    return { error: "capability.binding has an unsupported schemaVersion." };
  }
  const botId = text(metadata.botId);
  const tool = text(metadata.tool);
  const route = record(metadata.route);
  const connectorId = text(route.connectorId);
  const toolName = text(route.toolName);
  if (!botId || !tool || !connectorId || !toolName) {
    return { error: "capability.binding requires botId, tool and route connectorId/toolName." };
  }

  const resourceId = text(route.resourceId);
  const catalogGroup = text(route.catalogGroup);
  const resourceRevision =
    typeof route.resourceRevision === "string" || typeof route.resourceRevision === "number"
      ? route.resourceRevision
      : undefined;

  return {
    binding: {
      schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
      requirement,
      botId,
      tool,
      route: {
        connectorId,
        toolName,
        ...(resourceId ? { resourceId } : {}),
        ...(resourceRevision !== undefined ? { resourceRevision } : {}),
        ...(catalogGroup ? { catalogGroup } : {}),
      },
    },
  };
}
