import type { Actor } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createMarketService } from "./market.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const sourceRef = "c".repeat(40);

function skillContent(): string {
  return buildSkillMd({
    name: "Chrome Investigation",
    description: "Inspect and debug a browser page.",
    body: "Use the browser debugging workflow.",
  });
}

function setup(fetch: typeof globalThis.fetch) {
  const rows: Array<Record<string, unknown>> = [];
  const marketEntry = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        ...data,
        id: "market-1",
        adaptedContent: null,
        adaptationMode: null,
        sourcePath: data.sourcePath ?? null,
        license: data.license ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      rows.push(row);
      return row;
    }),
  };
  return {
    marketEntry,
    service: createMarketService({ marketEntry } as unknown as PrismaClient, { fetch }),
  };
}

describe("Market curated GitHub import", () => {
  it("fetches the exact pinned original and stores server-derived provenance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.href).toBe(
        `https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/${sourceRef}/skills/chrome-devtools/SKILL.md`,
      );
      expect(init?.redirect).toBe("manual");
      return new Response(skillContent(), {
        status: 200,
        headers: { "content-type": "text/markdown" },
      });
    });
    const { service, marketEntry } = setup(fetch);

    const result = await service.importGithub(actor, {
      kind: "skill",
      key: `ChromeDevTools/chrome-devtools-mcp:chrome-devtools@${sourceRef}`,
      tags: ["browser", "debug"],
      repository: "ChromeDevTools/chrome-devtools-mcp",
      sourcePath: "skills/chrome-devtools/SKILL.md",
      sourceRef,
      metadata: { publisher: "Chrome DevTools" },
    });

    expect(result).toMatchObject({
      name: "Chrome Investigation",
      repository: "ChromeDevTools/chrome-devtools-mcp",
      sourcePath: "skills/chrome-devtools/SKILL.md",
      sourceRef,
      license: "Apache-2.0",
      trust: "curated",
      originalContent: skillContent(),
    });
    expect(result.sourceUrl).toBe(
      `https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/${sourceRef}/skills/chrome-devtools/SKILL.md`,
    );
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(marketEntry.create).toHaveBeenCalledOnce();
  });

  it("rejects an uncurated repository before making a network request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { service } = setup(fetch);

    await expect(
      service.importGithub(actor, {
        kind: "skill",
        key: `random/example:test@${sourceRef}`,
        tags: [],
        repository: "random/example",
        sourcePath: "SKILL.md",
        sourceRef,
        metadata: {},
      }),
    ).rejects.toThrow("not in the curated Market source set");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects source-path traversal before making a network request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { service } = setup(fetch);

    await expect(
      service.importGithub(actor, {
        kind: "skill",
        key: `trusted:bad-path@${sourceRef}`,
        tags: [],
        repository: "openai/openai-cookbook",
        sourcePath: "../SKILL.md",
        sourceRef,
        metadata: {},
      }),
    ).rejects.toThrow("Invalid Market GitHub source path");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects redirects from the fixed pinned-content host", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/payload" },
        }),
    );
    const { service } = setup(fetch);

    await expect(
      service.importGithub(actor, {
        kind: "skill",
        key: `trusted:redirect@${sourceRef}`,
        tags: [],
        repository: "openai/openai-cookbook",
        sourcePath: ".codex/skills/docs-editor/SKILL.md",
        sourceRef,
        metadata: {},
      }),
    ).rejects.toThrow("redirected unexpectedly");
  });

  it("rejects an oversized source before reading its body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("ignored", {
          status: 200,
          headers: { "content-length": "200001" },
        }),
    );
    const { service } = setup(fetch);

    await expect(
      service.importGithub(actor, {
        kind: "skill",
        key: `trusted:large@${sourceRef}`,
        tags: [],
        repository: "openai/openai-cookbook",
        sourcePath: ".codex/skills/docs-editor/SKILL.md",
        sourceRef,
        metadata: {},
      }),
    ).rejects.toThrow("too large");
  });
});
