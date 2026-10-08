import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ResolverImplementation = {
  name: string;
  kind: string;
  reference: string;
  priority: number;
  readOnly: boolean;
  constraints: string[];
};
type ResolverSeed = {
  key: string;
  content: { semanticKey: string; implementations: ResolverImplementation[] };
};
const manifest = JSON.parse(
  readFileSync(new URL("../../../market/resolver-seeds.v1.json", import.meta.url), "utf8"),
) as { schemaVersion: string; entries: ResolverSeed[] };

describe("Market Resolver seed routing", () => {
  it("has 22 distinct semantic Resolvers with ordered, non-duplicate priorities", () => {
    expect(manifest.schemaVersion).toBe("market-resolver-seeds-v1");
    expect(manifest.entries).toHaveLength(22);
    expect(new Set(manifest.entries.map((entry) => entry.key)).size).toBe(22);
    for (const entry of manifest.entries) {
      expect(entry.content.semanticKey).toBe(entry.key);
      const implementations = entry.content.implementations;
      expect(implementations.length).toBeGreaterThan(0);
      const priorities = implementations.map((implementation) => implementation.priority);
      expect(new Set(priorities).size).toBe(priorities.length);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
      for (const implementation of implementations) {
        expect(implementation.reference.length).toBeGreaterThan(0);
        expect(implementation.constraints.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses the existing Browser v2 auto router before optional external MCP providers", () => {
    const semantic = manifest.entries.find((entry) => entry.key === "browser.semantic");
    expect(semantic).toBeDefined();
    const selected = semantic?.content.implementations[0];
    expect(selected?.reference).toBe("rakazo:computer/browser");
    expect(selected?.kind).toBe("browser");
    expect(selected?.priority).toBe(1);
    expect(selected?.constraints.join(" ")).toMatch(/Persistent, then OpenCLI/);
    expect(selected?.constraints.join(" ")).toMatch(/CDP and Extension are explicit opt-in/);
    const optional = semantic?.content.implementations.slice(1) ?? [];
    expect(optional).toHaveLength(2);
    expect(optional.every((implementation) => implementation.kind === "mcp")).toBe(true);
    expect(
      optional.every((implementation) =>
        implementation.constraints.join(" ").includes("authorized"),
      ),
    ).toBe(true);
  });
});
