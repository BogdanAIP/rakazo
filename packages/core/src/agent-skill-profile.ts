import { buildSkillMd, parseSkillMd } from "./agent-skill.js";

export const RCCL_SKILL_PROFILE_VERSION = "rccl-skill-v1" as const;
export const RCCL_SKILL_REQUIRED_SECTIONS = [
  "PURPOSE",
  "INPUT",
  "PRECONDITION",
  "PROCEDURE",
  "VERIFY",
  "FAIL",
  "OUTPUT",
] as const;
export const RCCL_SKILL_OPTIONAL_SECTIONS = ["FORBID"] as const;

export type RcclSkillSection =
  | (typeof RCCL_SKILL_REQUIRED_SECTIONS)[number]
  | (typeof RCCL_SKILL_OPTIONAL_SECTIONS)[number];

export type RcclSkillFinding = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  section?: RcclSkillSection;
};

export type RcclSkillAnalysis = {
  profileVersion: typeof RCCL_SKILL_PROFILE_VERSION;
  declaredProfile: string | null;
  profileDeclared: boolean;
  parseValid: boolean;
  strictReady: boolean;
  sections: Array<{
    name: RcclSkillSection;
    present: boolean;
    occurrences: number;
    contentChars: number;
  }>;
  findings: RcclSkillFinding[];
};

type Heading = { section: RcclSkillSection; start: number; end: number };

const REQUIRED = new Set<string>(RCCL_SKILL_REQUIRED_SECTIONS);
const ALL_SECTIONS = new Set<string>([
  ...RCCL_SKILL_REQUIRED_SECTIONS,
  ...RCCL_SKILL_OPTIONAL_SECTIONS,
]);

function normalizeHeading(value: string): RcclSkillSection | null {
  const normalized = value
    .trim()
    .replace(/[*_]/g, "")
    .split(String.fromCharCode(96))
    .join("")
    .replace(/[.:]+$/, "")
    .trim()
    .toUpperCase();
  return ALL_SECTIONS.has(normalized) ? (normalized as RcclSkillSection) : null;
}

function extractHeadings(body: string): Heading[] {
  const lines = body.split(/\r?\n/);
  const raw: Array<{ section: RcclSkillSection; start: number }> = [];
  const backtickFence = String.fromCharCode(96, 96, 96);
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed.startsWith(backtickFence) || trimmed.startsWith("~~~")) {
      const marker = trimmed.slice(0, 3);
      fence = fence === marker ? null : (fence ?? marker);
      continue;
    }
    if (fence) continue;
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(trimmed);
    if (!heading) continue;
    const section = normalizeHeading(heading[2] ?? "");
    if (section) raw.push({ section, start: index });
  }

  return raw.map((item, index) => ({
    section: item.section,
    start: item.start,
    end: raw[index + 1]?.start ?? lines.length,
  }));
}

function sectionText(body: string, heading: Heading): string {
  return body
    .split(/\r?\n/)
    .slice(heading.start + 1, heading.end)
    .join("\n")
    .trim();
}

function findingSeverity(strict: boolean): "warning" | "error" {
  return strict ? "error" : "warning";
}

function hasNumberedStep(value: string): boolean {
  return value.split(/\r?\n/).some((line) => /^\s*\d+[.)]\s+\S/.test(line));
}

function hasListItem(value: string): boolean {
  return value.split(/\r?\n/).some((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/.test(line));
}

export function analyzeRcclSkillMd(
  content: string,
  options: { strict?: boolean } = {},
): RcclSkillAnalysis {
  const parsed = parseSkillMd(content);
  if ("error" in parsed) {
    return {
      profileVersion: RCCL_SKILL_PROFILE_VERSION,
      declaredProfile: null,
      profileDeclared: false,
      parseValid: false,
      strictReady: false,
      sections: RCCL_SKILL_REQUIRED_SECTIONS.map((name) => ({
        name,
        present: false,
        occurrences: 0,
        contentChars: 0,
      })),
      findings: [{ code: "skill-md-invalid", severity: "error", message: parsed.error }],
    };
  }

  const declared = parsed.frontmatter["rakazo-profile"];
  const declaredProfile = typeof declared === "string" ? declared.trim() || null : null;
  const profileDeclared = declaredProfile === RCCL_SKILL_PROFILE_VERSION;
  const enforce = options.strict === true || profileDeclared;
  const headings = extractHeadings(parsed.body);
  const findings: RcclSkillFinding[] = [];

  if (declaredProfile && !profileDeclared) {
    findings.push({
      code: "unknown-profile",
      severity: "warning",
      message: `Unknown rakazo-profile: ${declaredProfile}.`,
    });
  }
  if (!profileDeclared) {
    findings.push({
      code: "profile-not-declared",
      severity: "info",
      message:
        "Legacy-compatible Skill. Add rakazo-profile: rccl-skill-v1 to opt in to the controlled profile.",
    });
  }

  const sections = [...RCCL_SKILL_REQUIRED_SECTIONS, ...RCCL_SKILL_OPTIONAL_SECTIONS].map(
    (name) => {
      const matches = headings.filter((heading) => heading.section === name);
      return {
        name,
        present: matches.length > 0,
        occurrences: matches.length,
        contentChars: matches.reduce(
          (sum, heading) => sum + sectionText(parsed.body, heading).length,
          0,
        ),
      };
    },
  );

  for (const section of sections) {
    const level = findingSeverity(enforce);
    if (REQUIRED.has(section.name) && !section.present) {
      findings.push({
        code: "missing-required-section",
        severity: level,
        message: `Missing required section: ${section.name}.`,
        section: section.name,
      });
    }
    if (section.occurrences > 1) {
      findings.push({
        code: "duplicate-section",
        severity: level,
        message: `Section ${section.name} appears more than once.`,
        section: section.name,
      });
    }
    if (section.present && section.contentChars === 0) {
      findings.push({
        code: "empty-section",
        severity: level,
        message: `Section ${section.name} is empty.`,
        section: section.name,
      });
    }
  }

  const procedureHeading = headings.find((heading) => heading.section === "PROCEDURE");
  if (procedureHeading) {
    const procedure = sectionText(parsed.body, procedureHeading);
    if (procedure && !hasNumberedStep(procedure)) {
      findings.push({
        code: "procedure-not-numbered",
        severity: findingSeverity(enforce),
        message: "PROCEDURE must use explicit numbered steps.",
        section: "PROCEDURE",
      });
    }
  }

  for (const sectionName of ["INPUT", "PRECONDITION", "VERIFY", "FAIL", "OUTPUT"] as const) {
    const heading = headings.find((item) => item.section === sectionName);
    if (!heading) continue;
    const value = sectionText(parsed.body, heading);
    if (value && !hasListItem(value)) {
      findings.push({
        code: "section-not-list",
        severity: findingSeverity(enforce),
        message: `${sectionName} should use explicit list items.`,
        section: sectionName,
      });
    }
  }

  return {
    profileVersion: RCCL_SKILL_PROFILE_VERSION,
    declaredProfile,
    profileDeclared,
    parseValid: true,
    strictReady: profileDeclared && findings.every((finding) => finding.severity !== "error"),
    sections,
    findings,
  };
}

export function buildRcclSkillTemplate(input: {
  name: string;
  description: string;
  capabilityRequirements?: string[];
}): string {
  const requirements =
    input.capabilityRequirements && input.capabilityRequirements.length > 0
      ? input.capabilityRequirements
          .map((value) => `- [REQUIRE] Capability: ${value.trim()}`)
          .join("\n")
      : "- [REQUIRE] State the required Project capability or write NONE.";

  const body = [
    `# ${input.name.trim()}`,
    "",
    "## PURPOSE",
    "",
    "State one concrete outcome for this Skill.",
    "",
    "## INPUT",
    "",
    "- [INPUT] State each required input and its meaning.",
    "",
    "## PRECONDITION",
    "",
    requirements,
    "- [REQUIRE] State each condition that must be true before PROCEDURE starts.",
    "",
    "## PROCEDURE",
    "",
    "1. Perform one explicit action.",
    "2. Verify the result before the next state-changing action.",
    "3. Continue with one explicit action per step.",
    "",
    "## VERIFY",
    "",
    "- [VERIFY] State the observable condition that proves success.",
    "",
    "## FORBID",
    "",
    "- [FORBID] State prohibited actions, or write NONE.",
    "",
    "## FAIL",
    "",
    "- [FAIL] Stop on an unmet precondition or failed verification.",
    "- [FAIL] Report the blocking fact. Do not invent missing state.",
    "",
    "## OUTPUT",
    "",
    "- [OUTPUT] Return the verified result and any unresolved blocker.",
    "",
  ].join("\n");

  return buildSkillMd({
    name: input.name,
    description: input.description,
    body,
    frontmatter: { "rakazo-profile": RCCL_SKILL_PROFILE_VERSION },
  });
}
