import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type PopulationItem = {
  kind: "skill" | "resolver";
  key: string;
  repository: string;
  sourceRef: string;
  sourcePath?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
};

type PopulationBatch = {
  id: string;
  procedure: "market/importGithubBatch" | "market/importBatch";
  items: PopulationItem[];
};

type PopulationManifest = {
  counts: {
    generalSkills: number;
    tradingSkills: number;
    resolverEntries: number;
    total: number;
  };
  policy: {
    tradingMode: string;
    executionBoundary: string;
  };
  batches: PopulationBatch[];
};

async function manifest(): Promise<PopulationManifest> {
  const raw = await readFile(
    new URL("../../../market/population-batches.v1.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(raw) as PopulationManifest;
}

describe("Market population manifest", () => {
  it("contains the complete first population wave with pinned provenance", async () => {
    const data = await manifest();
    expect(data.counts).toEqual({
      generalSkills: 36,
      tradingSkills: 55,
      resolverEntries: 22,
      total: 113,
    });
    expect(data.policy.tradingMode).toBe("paper-only");
    expect(data.policy.executionBoundary).toContain("authorized");

    const items = data.batches.flatMap((batch) => batch.items);
    expect(items).toHaveLength(113);
    expect(new Set(items.map((item) => item.key)).size).toBe(113);

    for (const item of items) {
      expect(item.sourceRef).toMatch(/^[0-9a-f]{40}$/);
      expect(item.repository).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    }
  });

  it("keeps GitHub Skills and Resolver fragments on their matching batch procedures", async () => {
    const data = await manifest();
    for (const batch of data.batches) {
      if (batch.procedure === "market/importGithubBatch") {
        expect(batch.items.every((item) => item.kind === "skill" && Boolean(item.sourcePath))).toBe(
          true,
        );
      } else {
        expect(
          batch.items.every((item) => item.kind === "resolver" && Boolean(item.sourceUrl)),
        ).toBe(true);
      }
    }
  });
});
