import { CAPABILITY_BINDING_SCHEMA_VERSION, CAPABILITY_PROFILE_SCHEMA_VERSION } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { resolveProjectCapabilityProfile } from "./chatgpt-capability-profile.js";

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
    if (!(procedure in answers)) throw new Error("Unexpected procedure: " + procedure);
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
      readyForRequiredWork: true,
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
    expect(result.readyForRequiredWork).toBe(false);
    expect(resolutions).toContainEqual(
      expect.objectContaining({ requirement: "research.web", status: "stale" }),
    );
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
