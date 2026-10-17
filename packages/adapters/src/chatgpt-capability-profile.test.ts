import { CAPABILITY_BINDING_SCHEMA_VERSION, CAPABILITY_PROFILE_SCHEMA_VERSION } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  assignProjectCapabilityBinding,
  resolveProjectCapabilityProfile,
} from "./chatgpt-capability-profile.js";

function reader(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    "projects/context": {
      project: { id: "project-1", slug: "aihot", name: "AIHOT" },
      resources: [
        {
          id: "profile-1",
          kind: "capability.profile",
          ref: "active",
          metadata: {
            schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
            catalogVersion: 1,
            profile: "aihot",
            required: ["repo.read", "research.web"],
            optional: ["repo.write", "browser.semantic", "computer.exec"],
            denied: ["messaging.telegram"],
          },
        },
        {
          id: "repo-1",
          kind: "github.repo",
          ref: "BogdanAIP/aihot-ru",
          metadata: { githubAccess: "autonomous_write" },
        },
        {
          id: "binding-1",
          kind: "capability.binding",
          ref: "research.web",
          metadata: {
            schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
            botId: "bot-1",
            tool: "research_search",
            route: {
              connectorId: "installed",
              toolName: "research_search",
              resourceId: "cap-research",
            },
          },
        },
      ],
      openTasks: [{ id: "task-1", botId: "bot-1" }],
    },
    "computer/status": {
      botId: "bot-1",
      mode: "dedicated",
      kind: "desktop",
      state: "running",
    },
    "capabilities/tools": [
      {
        name: "research_search",
        readOnly: true,
        route: {
          connectorId: "installed",
          toolName: "research_search",
          resourceId: "cap-research",
        },
      },
    ],
    ...overrides,
  };

  return async (procedure: string): Promise<unknown> => {
    if (!(procedure in answers)) throw new Error(`Unexpected procedure: ${procedure}`);
    return answers[procedure];
  };
}

describe("project capability profile resolver", () => {
  it("resolves project grants, explicit bindings, computers and denied capabilities", async () => {
    const result = await resolveProjectCapabilityProfile(reader(), "project-1");
    const resolutions = result.resolutions as Array<Record<string, unknown>>;

    expect(result).toMatchObject({
      assigned: true,
      valid: true,
      requiredSurfacePresent: true,
      linkedBotIds: ["bot-1"],
      runningComputerBotIds: ["bot-1"],
    });
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "repo.read", status: "ready" }),
    );
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "repo.write", status: "ready" }),
    );
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "research.web", status: "ready" }),
    );
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "computer.exec", status: "available" }),
    );
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "browser.semantic", status: "missing" }),
    );
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "messaging.telegram", status: "denied" }),
    );
  });

  it("fails closed when no active profile is assigned", async () => {
    const result = await resolveProjectCapabilityProfile(
      reader({
        "projects/context": {
          project: { id: "project-1", slug: "plain", name: "Plain" },
          resources: [],
          openTasks: [],
        },
      }),
      "project-1",
    );

    expect(result).toMatchObject({
      assigned: false,
      resolutions: [],
    });
  });

  it("marks an explicit binding stale when the authorized route changed", async () => {
    const result = await resolveProjectCapabilityProfile(
      reader({
        "capabilities/tools": [
          {
            name: "research_search",
            readOnly: true,
            route: {
              connectorId: "installed",
              toolName: "research_search",
              resourceId: "different-capability",
            },
          },
        ],
      }),
      "project-1",
    );
    const resolutions = result.resolutions as Array<Record<string, unknown>>;
    expect(result.requiredSurfacePresent).toBe(false);
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "research.web", status: "stale" }),
    );
  });

  it("does not accept a write tool for a read-only semantic requirement", async () => {
    const result = await resolveProjectCapabilityProfile(
      reader({
        "capabilities/tools": [
          {
            name: "research_search",
            readOnly: false,
            route: {
              connectorId: "installed",
              toolName: "research_search",
              resourceId: "cap-research",
            },
          },
        ],
      }),
      "project-1",
    );
    const resolutions = result.resolutions as Array<Record<string, unknown>>;

    expect(result.requiredSurfacePresent).toBe(false);
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "research.web", status: "stale" }),
    );
  });

  it("writes a binding only after exact linked-Bot authorization verification", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const call = async (procedure: string, input?: Record<string, unknown>): Promise<unknown> => {
      if (procedure === "projects/context") {
        return {
          project: { id: "project-1", slug: "aihot", name: "AIHOT" },
          resources: [
            {
              id: "profile-1",
              kind: "capability.profile",
              ref: "active",
              metadata: {
                schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
                catalogVersion: 1,
                profile: "aihot",
                required: ["research.web"],
                optional: [],
                denied: [],
              },
            },
          ],
          openTasks: [{ id: "task-1", botId: "bot-1" }],
        };
      }
      if (procedure === "capabilities/tools") {
        return [
          {
            name: "research_search",
            readOnly: true,
            route: {
              connectorId: "installed",
              toolName: "research_search",
              resourceId: "cap-research",
            },
          },
        ];
      }
      if (procedure === "projects/resources/upsert") {
        writes.push(input ?? {});
        return { id: "binding-1", ...(input ?? {}) };
      }
      throw new Error(`Unexpected procedure: ${procedure}`);
    };

    const result = await assignProjectCapabilityBinding(call, {
      projectId: "project-1",
      requirement: "research.web",
      botId: "bot-1",
      tool: "research_search",
      route: {
        connectorId: "installed",
        toolName: "research_search",
        resourceId: "cap-research",
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      projectId: "project-1",
      kind: "capability.binding",
      ref: "research.web",
      metadata: {
        schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
        botId: "bot-1",
        tool: "research_search",
      },
    });
    expect(result).toMatchObject({
      projectId: "project-1",
      binding: { requirement: "research.web", botId: "bot-1" },
    });
  });

  it("does not bind a capability through an unrelated Bot", async () => {
    const call = async (procedure: string): Promise<unknown> => {
      if (procedure === "projects/context") {
        return {
          project: { id: "project-1", slug: "aihot", name: "AIHOT" },
          resources: [
            {
              kind: "capability.profile",
              ref: "active",
              metadata: {
                schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
                catalogVersion: 1,
                profile: "aihot",
                required: ["research.web"],
                optional: [],
                denied: [],
              },
            },
          ],
          openTasks: [{ id: "task-1", botId: "bot-linked" }],
        };
      }
      throw new Error(`Unexpected procedure: ${procedure}`);
    };

    await expect(
      assignProjectCapabilityBinding(call, {
        projectId: "project-1",
        requirement: "research.web",
        botId: "bot-unrelated",
        tool: "research_search",
        route: { connectorId: "installed", toolName: "research_search" },
      }),
    ).rejects.toThrow(/not linked/i);
  });

  it("rejects malformed active profile metadata", async () => {
    const result = await resolveProjectCapabilityProfile(
      reader({
        "projects/context": {
          project: { id: "project-1", slug: "bad", name: "Bad" },
          resources: [
            {
              kind: "capability.profile",
              ref: "active",
              metadata: {
                schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
                catalogVersion: 1,
                profile: "bad",
                required: ["not.real"],
                optional: [],
                denied: [],
              },
            },
          ],
          openTasks: [],
        },
      }),
      "project-1",
    );

    expect(result).toMatchObject({
      assigned: true,
      valid: false,
      resolutions: [],
    });
  });
});
