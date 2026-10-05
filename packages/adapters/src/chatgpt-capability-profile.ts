import {
  type CapabilityBindingSnapshot,
  type CapabilityProfileSnapshot,
  parseCapabilityBindingResource,
  parseCapabilityProfileResource,
  SEMANTIC_CAPABILITY_REQUIREMENTS,
  type SemanticCapabilityRequirement,
} from "@rakazo/core";
import type { ContextReader } from "./chatgpt-context.js";

type ResolutionStatus = "ready" | "available" | "missing" | "denied" | "stale";

type Resolution = {
  requirement: SemanticCapabilityRequirement;
  level: "required" | "optional" | "denied";
  status: ResolutionStatus;
  reason: string;
  discoveryQuery?: string;
  binding?: {
    resourceId: string | null;
    botId: string;
    tool: string;
    route: CapabilityBindingSnapshot["route"];
  };
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected Rakazo " + label + " response");
  }
  return value as Record<string, unknown>;
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Unexpected Rakazo " + label + " response");
  return value.map((item) => record(item, label));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function routeMatches(actualValue: unknown, expected: CapabilityBindingSnapshot["route"]): boolean {
  const actual = record(actualValue, "capability route");
  if (actual.connectorId !== expected.connectorId || actual.toolName !== expected.toolName) {
    return false;
  }
  if (expected.resourceId !== undefined && actual.resourceId !== expected.resourceId) return false;
  if (
    expected.resourceRevision !== undefined &&
    actual.resourceRevision !== expected.resourceRevision
  ) {
    return false;
  }
  if (expected.catalogGroup !== undefined && actual.catalogGroup !== expected.catalogGroup) {
    return false;
  }
  return true;
}

async function bindingIsLive(
  read: ContextReader,
  binding: CapabilityBindingSnapshot,
): Promise<boolean> {
  const tools = records(
    await read("capabilities/tools", {
      botId: binding.botId,
      query: binding.tool,
      limit: 100,
    }),
    "capabilities/tools",
  );
  const expectedAccess = SEMANTIC_CAPABILITY_REQUIREMENTS[binding.requirement].access;
  return tools.some(
    (tool) =>
      tool.name === binding.tool &&
      routeMatches(tool.route, binding.route) &&
      (expectedAccess !== "read" || tool.readOnly === true),
  );
}

async function runningComputerBotIds(read: ContextReader, botIds: string[]): Promise<Set<string>> {
  const running = new Set<string>();
  await Promise.all(
    botIds.map(async (botId) => {
      try {
        const status = record(await read("computer/status", { botId }), "computer/status");
        if (status.state === "running") running.add(botId);
      } catch {
        // A linked bot may not have an accessible Computer. The resolver reports missing below.
      }
    }),
  );
  return running;
}

function profileResource(
  resources: Record<string, unknown>[],
):
  | { resource: Record<string, unknown>; snapshot: CapabilityProfileSnapshot }
  | { error: string }
  | null {
  const matches = resources.filter(
    (resource) => resource.kind === "capability.profile" && resource.ref === "active",
  );
  if (matches.length === 0) return null;
  if (matches.length > 1)
    return { error: "Project has multiple active capability.profile resources." };
  const parsed = parseCapabilityProfileResource(matches[0]!);
  if (!parsed) return null;
  if ("error" in parsed) return parsed;
  return { resource: matches[0]!, snapshot: parsed.snapshot };
}

function bindingResources(
  resources: Record<string, unknown>[],
): Map<
  SemanticCapabilityRequirement,
  { resource: Record<string, unknown>; binding: CapabilityBindingSnapshot } | { error: string }
> {
  const result = new Map<
    SemanticCapabilityRequirement,
    { resource: Record<string, unknown>; binding: CapabilityBindingSnapshot } | { error: string }
  >();
  for (const resource of resources) {
    if (resource.kind !== "capability.binding") continue;
    const parsed = parseCapabilityBindingResource(resource);
    if (!parsed) continue;
    const requirement = text(resource.ref);
    if (!requirement || !(requirement in SEMANTIC_CAPABILITY_REQUIREMENTS)) continue;
    const key = requirement as SemanticCapabilityRequirement;
    if (result.has(key)) {
      result.set(key, {
        error: "Project has multiple capability.binding resources for " + key + ".",
      });
      continue;
    }
    result.set(key, "error" in parsed ? parsed : { resource, binding: parsed.binding });
  }
  return result;
}

function githubResources(resources: Record<string, unknown>[]): Record<string, unknown>[] {
  return resources.filter((resource) => resource.kind === "github.repo");
}

function repoWriteReady(resources: Record<string, unknown>[]): boolean {
  return githubResources(resources).some((resource) => {
    const metadata =
      resource.metadata &&
      typeof resource.metadata === "object" &&
      !Array.isArray(resource.metadata)
        ? (resource.metadata as Record<string, unknown>)
        : {};
    return metadata.githubAccess === "autonomous_write";
  });
}

export async function resolveProjectCapabilityProfile(
  read: ContextReader,
  projectId: string,
): Promise<Record<string, unknown>> {
  const context = record(await read("projects/context", { projectId }), "projects/context");
  const project = record(context.project, "projects/context project");
  const resources = records(context.resources, "projects/context resources");
  const openTasks = records(context.openTasks, "projects/context openTasks");
  const active = profileResource(resources);

  if (!active) {
    return {
      project: { id: project.id, slug: project.slug, name: project.name },
      assigned: false,
      resolutions: [],
      note: "No active capability.profile resource is assigned. Resolver does not install, authorize or broaden capabilities.",
    };
  }
  if ("error" in active) {
    return {
      project: { id: project.id, slug: project.slug, name: project.name },
      assigned: true,
      valid: false,
      error: active.error,
      resolutions: [],
    };
  }

  const linkedBotIds = new Set<string>();
  for (const resource of resources) {
    if (resource.kind === "rakazo.bot") {
      const id = text(resource.ref);
      if (id) linkedBotIds.add(id);
    }
  }
  for (const task of openTasks) {
    const id = text(task.botId);
    if (id) linkedBotIds.add(id);
  }

  const runningBots = await runningComputerBotIds(read, [...linkedBotIds]);
  const bindings = bindingResources(resources);
  const resolutions: Resolution[] = [];

  const resolveOne = async (
    requirement: SemanticCapabilityRequirement,
    level: "required" | "optional",
  ): Promise<Resolution> => {
    const info = SEMANTIC_CAPABILITY_REQUIREMENTS[requirement];

    if (requirement === "repo.read") {
      return githubResources(resources).length > 0
        ? {
            requirement,
            level,
            status: "ready",
            reason: "Project has an exact github.repo resource.",
          }
        : {
            requirement,
            level,
            status: "missing",
            reason: "Project has no github.repo resource.",
            discoveryQuery: info.discoveryQuery,
          };
    }

    if (requirement === "repo.write") {
      return repoWriteReady(resources)
        ? {
            requirement,
            level,
            status: "ready",
            reason: "Project github.repo has githubAccess=autonomous_write.",
          }
        : {
            requirement,
            level,
            status: "missing",
            reason: "Project has no autonomous_write GitHub grant.",
            discoveryQuery: info.discoveryQuery,
          };
    }

    if (
      requirement === "computer.exec" ||
      requirement === "computer.files" ||
      requirement === "browser.visual"
    ) {
      return runningBots.size > 0
        ? {
            requirement,
            level,
            status: "available",
            reason:
              "A linked Project execution Bot has a running Computer. Normal takeover/approval rules still apply.",
          }
        : {
            requirement,
            level,
            status: "missing",
            reason: "No linked Project execution Bot has a running accessible Computer.",
            discoveryQuery: info.discoveryQuery,
          };
    }

    const binding = bindings.get(requirement);
    if (binding) {
      if ("error" in binding) {
        return {
          requirement,
          level,
          status: "stale",
          reason: binding.error,
          discoveryQuery: info.discoveryQuery,
        };
      }
      try {
        const live = await bindingIsLive(read, binding.binding);
        return live
          ? {
              requirement,
              level,
              status: "ready",
              reason: "Exact capability.binding is present in the current authorized tool catalog.",
              binding: {
                resourceId: text(binding.resource.id) || null,
                botId: binding.binding.botId,
                tool: binding.binding.tool,
                route: binding.binding.route,
              },
            }
          : {
              requirement,
              level,
              status: "stale",
              reason: "Capability binding no longer matches the current authorized tool catalog.",
              discoveryQuery: info.discoveryQuery,
              binding: {
                resourceId: text(binding.resource.id) || null,
                botId: binding.binding.botId,
                tool: binding.binding.tool,
                route: binding.binding.route,
              },
            };
      } catch {
        return {
          requirement,
          level,
          status: "stale",
          reason:
            "Capability binding could not be verified against the current authorized tool catalog.",
          discoveryQuery: info.discoveryQuery,
        };
      }
    }

    return {
      requirement,
      level,
      status: "missing",
      reason: "No explicit capability.binding is registered for this semantic requirement.",
      discoveryQuery: info.discoveryQuery,
    };
  };

  for (const requirement of active.snapshot.required) {
    resolutions.push(await resolveOne(requirement, "required"));
  }
  for (const requirement of active.snapshot.optional) {
    resolutions.push(await resolveOne(requirement, "optional"));
  }
  for (const requirement of active.snapshot.denied) {
    resolutions.push({
      requirement,
      level: "denied",
      status: "denied",
      reason: "The active Project capability profile explicitly denies this semantic capability.",
    });
  }

  const required = resolutions.filter((item) => item.level === "required");
  const unresolvedRequired = required.filter(
    (item) => item.status !== "ready" && item.status !== "available",
  );

  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    assigned: true,
    valid: true,
    profileResourceId: active.resource.id,
    profile: active.snapshot,
    linkedBotIds: [...linkedBotIds].sort(),
    runningComputerBotIds: [...runningBots].sort(),
    resolutions,
    requiredSurfacePresent: unresolvedRequired.length === 0,
    counts: {
      required: required.length,
      unresolvedRequired: unresolvedRequired.length,
      optional: resolutions.filter((item) => item.level === "optional").length,
      denied: resolutions.filter((item) => item.level === "denied").length,
    },
    note: "Resolution is read-only. ready/available does not bypass existing Project grants, capability assignments, Computer control leases, approvals or tool policy. Missing capabilities are not installed automatically.",
  };
}
