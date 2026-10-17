import { describe, expect, it } from "vitest";
import {
  BUILTIN_CAPABILITY_PROFILES,
  CAPABILITY_BINDING_SCHEMA_VERSION,
  CAPABILITY_PROFILE_SCHEMA_VERSION,
  getBuiltinCapabilityProfile,
  materializeCapabilityProfile,
  parseCapabilityBindingResource,
  parseCapabilityProfileResource,
} from "./capability-profile.js";

describe("capability profiles", () => {
  it("exposes the initial built-in catalog", () => {
    expect(BUILTIN_CAPABILITY_PROFILES.map((profile) => profile.slug)).toEqual([
      "web-development",
      "research",
      "aihot",
      "trading-research",
    ]);
    expect(getBuiltinCapabilityProfile("aihot")?.required).toContain("research.web");
    expect(getBuiltinCapabilityProfile("trading-research")?.denied).toEqual(["trading.execute"]);
  });

  it("materializes a stable snapshot with deny taking precedence", () => {
    const snapshot = materializeCapabilityProfile({
      profile: "web-development",
      addRequired: ["browser.semantic", "repo.write"],
      addOptional: ["browser.semantic", "citations"],
      deny: ["repo.write"],
    });

    expect(snapshot).toEqual({
      schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
      catalogVersion: 1,
      profile: "web-development",
      required: ["repo.read", "browser.semantic"],
      optional: ["computer.files", "computer.exec", "browser.debug", "browser.visual", "citations"],
      denied: ["repo.write"],
    });
  });

  it("parses the active profile resource and rejects conflicts", () => {
    const parsed = parseCapabilityProfileResource({
      kind: "capability.profile",
      ref: "active",
      metadata: {
        schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
        catalogVersion: 1,
        profile: "aihot",
        required: ["repo.read"],
        optional: ["browser.semantic"],
        denied: ["repo.write"],
      },
    });
    expect(parsed).toEqual({
      snapshot: expect.objectContaining({ profile: "aihot", required: ["repo.read"] }),
    });

    expect(
      parseCapabilityProfileResource({
        kind: "capability.profile",
        ref: "active",
        metadata: {
          schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
          catalogVersion: 1,
          profile: "broken",
          required: ["repo.write"],
          optional: [],
          denied: ["repo.write"],
        },
      }),
    ).toEqual({
      error: "capability.profile cannot both require and deny the same capability.",
    });
  });

  it("ignores unrelated resources and rejects unknown requirements", () => {
    expect(parseCapabilityProfileResource({ kind: "github.repo", ref: "x" })).toBeNull();
    expect(
      parseCapabilityProfileResource({
        kind: "capability.profile",
        ref: "active",
        metadata: {
          schemaVersion: CAPABILITY_PROFILE_SCHEMA_VERSION,
          catalogVersion: 1,
          profile: "custom",
          required: ["unknown"],
          optional: [],
          denied: [],
        },
      }),
    ).toEqual({
      error: "capability.profile requirements contain an unknown semantic capability.",
    });
  });

  it("parses explicit capability bindings", () => {
    expect(
      parseCapabilityBindingResource({
        kind: "capability.binding",
        ref: "browser.semantic",
        metadata: {
          schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
          botId: "bot-1",
          tool: "playwright_snapshot",
          route: {
            connectorId: "installed",
            toolName: "playwright_snapshot",
            resourceId: "cap-1",
            catalogGroup: "Playwright",
          },
        },
      }),
    ).toEqual({
      binding: {
        schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
        requirement: "browser.semantic",
        botId: "bot-1",
        tool: "playwright_snapshot",
        route: {
          connectorId: "installed",
          toolName: "playwright_snapshot",
          resourceId: "cap-1",
          catalogGroup: "Playwright",
        },
      },
    });
  });
});
