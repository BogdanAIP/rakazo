import { readFile } from "node:fs/promises";
import { analyzeRcclSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { CURATED_MARKET_REPOSITORIES } from "./market.js";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("pstack candidate integration", () => {
  it("pins priority candidates without granting execution authority", async () => {
    const batch = JSON.parse(await read("../../../market/pstack-priority.v1.json"));
    const catalog = JSON.parse(await read("../../../market/skill-candidates.v1.json"));
    const trusted = JSON.parse(await read("../../../market/trusted-sources.v1.json"));
    const source = catalog.sources.find((s: { repository: string }) => s.repository === "cursor/plugins");
    expect(CURATED_MARKET_REPOSITORIES["cursor/plugins"].license).toBe("MIT");
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.skills).toContain("pstack/skills/reframe/SKILL.md");
    expect(trusted.sources.find((s: { repository: string }) => s.repository === "cursor/plugins").commit).toBe(source.commit);
    expect(batch.items).toHaveLength(12);
    expect(new Set(batch.items.map((item: { key: string }) => item.key)).size).toBe(12);
    for (const item of batch.items) {
      expect(item.repository).toBe(source.repository);
      expect(item.sourceRef).toBe(source.commit);
      expect(source.skills).toContain(item.sourcePath);
      expect(item.key).toBe(`${item.repository}:${item.sourcePath}@${item.sourceRef}`);
      expect(item.metadata.invocation).toBe("explicit-only");
      expect(item.metadata.reviewBeforeInstall).toBe(true);
    }
  });

  it.each(["discover","deep-research","verify","simplify","autofix","benchmark","compare-reference","engineering"])("validates portable RCCL skill %s", async (name) => {
    const content = await read(`../../../.agents/skills/${name}/SKILL.md`);
    const result = analyzeRcclSkillMd(content);
    expect(result.parseValid).toBe(true);
    expect(result.strictReady).toBe(true);
  });
});
