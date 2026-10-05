import { describe, expect, it } from "vitest";
import {
  analyzeRcclSkillMd,
  buildRcclSkillTemplate,
  RCCL_SKILL_PROFILE_VERSION,
} from "./agent-skill-profile.js";
import { buildSkillMd } from "./agent-skill.js";

describe("RCCL Skill Profile", () => {
  it("builds a strict-ready canonical template", () => {
    const content = buildRcclSkillTemplate({
      name: "GitHub Feature Development",
      description: "Develop one verified project-scoped GitHub feature.",
      capabilityRequirements: ["github.write", "computer.git"],
    });

    const result = analyzeRcclSkillMd(content, { strict: true });

    expect(result.profileVersion).toBe(RCCL_SKILL_PROFILE_VERSION);
    expect(result.profileDeclared).toBe(true);
    expect(result.parseValid).toBe(true);
    expect(result.strictReady).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(content).toContain("rakazo-profile: rccl-skill-v1");
    expect(content).toContain("## PROCEDURE");
    expect(content).toContain("[REQUIRE] Capability: github.write");
  });

  it("keeps legacy skills compatible and reports advisory findings", () => {
    const content = buildSkillMd({
      name: "Legacy",
      description: "Existing legacy skill.",
      body: "# Legacy\n\nDo the work.",
    });

    const result = analyzeRcclSkillMd(content);

    expect(result.parseValid).toBe(true);
    expect(result.profileDeclared).toBe(false);
    expect(result.strictReady).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "profile-not-declared", severity: "info" }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "missing-required-section", severity: "warning" }),
    );
    expect(result.findings.some((finding) => finding.severity === "error")).toBe(false);
  });

  it("enforces the required structure after a skill opts in", () => {
    const content = buildSkillMd({
      name: "Broken profiled skill",
      description: "Declares the profile without the required sections.",
      body: "# Broken\n\n## PURPOSE\n\nOnly purpose.",
      frontmatter: { "rakazo-profile": RCCL_SKILL_PROFILE_VERSION },
    });

    const result = analyzeRcclSkillMd(content);

    expect(result.profileDeclared).toBe(true);
    expect(result.strictReady).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "missing-required-section",
        severity: "error",
        section: "PROCEDURE",
      }),
    );
  });

  it("does not treat headings inside fenced examples as profile sections", () => {
    const fence = String.fromCharCode(96, 96, 96);
    const content = buildSkillMd({
      name: "Examples",
      description: "Contains a fenced example.",
      body: [
        "# Examples",
        "",
        fence,
        "## PROCEDURE",
        "1. Example only.",
        fence,
        "",
        "## PURPOSE",
        "",
        "Explain examples.",
      ].join("\n"),
    });

    const result = analyzeRcclSkillMd(content);

    expect(result.sections.find((section) => section.name === "PROCEDURE")).toMatchObject({
      present: false,
      occurrences: 0,
    });
  });

  it("requires numbered procedure steps and list-shaped control sections", () => {
    const content = buildSkillMd({
      name: "Shape checks",
      description: "Checks deterministic section shapes.",
      frontmatter: { "rakazo-profile": RCCL_SKILL_PROFILE_VERSION },
      body: [
        "# Shape checks",
        "## PURPOSE",
        "Do one thing.",
        "## INPUT",
        "Input is projectId.",
        "## PRECONDITION",
        "- ready",
        "## PROCEDURE",
        "Perform the operation.",
        "## VERIFY",
        "- verified",
        "## FAIL",
        "- stop",
        "## OUTPUT",
        "- result",
      ].join("\n"),
    });

    const result = analyzeRcclSkillMd(content);

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "section-not-list", section: "INPUT", severity: "error" }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "procedure-not-numbered",
        section: "PROCEDURE",
        severity: "error",
      }),
    );
  });
});
