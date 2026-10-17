# RCCL Skill Profile v1

RCCL Skill Profile v1 is an optional controlled-authoring profile for Rakazo Agent Skills.

It does not replace SKILL.md. It adds deterministic structure on top of the existing YAML-frontmatter + Markdown format so ChatGPT and other agents can execute reusable procedures with less ambiguity.

Profile identifier:

    rakazo-profile: rccl-skill-v1

## Compatibility

Legacy Skills remain valid and executable.

Builtin and plugin Skills remain read-only and are not rewritten.

A user-created Skill opts in by declaring the RCCL profile in frontmatter. After opt-in, missing or malformed required sections become profile errors.

Without the profile declaration, the analyzer reports advisory findings only.

The analyzer is deterministic and does not invoke an LLM.

## Required sections

An RCCL-profiled Skill uses these required Markdown sections:

- PURPOSE — one concrete outcome.
- INPUT — explicit required inputs.
- PRECONDITION — conditions that must be true before execution.
- PROCEDURE — ordered, numbered actions.
- VERIFY — observable success conditions.
- FAIL — behavior for unmet preconditions or failed verification.
- OUTPUT — the verified result that the Skill returns.

FORBID is optional but recommended when the workflow has safety, permission, scope or destructive-action boundaries.

Canonical example:

    ---
    name: GitHub Feature Development
    description: Develop one verified project-scoped GitHub feature.
    rakazo-profile: rccl-skill-v1
    ---

    # GitHub Feature Development

    ## PURPOSE

    Produce one reviewed feature change in the selected Project repository.

    ## INPUT

    - [INPUT] projectId: Rakazo Project id.
    - [INPUT] task: requested feature.

    ## PRECONDITION

    - [REQUIRE] Capability: github.write
    - [REQUIRE] The Project has one exact github.repo resource.

    ## PROCEDURE

    1. Load the Project context.
    2. Verify repository, branch and current HEAD.
    3. Create or verify an isolated worktree.
    4. Inspect relevant code.
    5. Make the smallest required change.
    6. Run focused tests.
    7. Commit and open or update the Project PR.
    8. Verify exact-head CI.
    9. Write the Project checkpoint.

    ## VERIFY

    - [VERIFY] Tests for the changed behavior pass.
    - [VERIFY] GitHub HEAD equals the checkpoint HEAD.

    ## FORBID

    - [FORBID] Do not write outside the Project repository grant.
    - [FORBID] Do not overwrite unrelated dirty files.

    ## FAIL

    - [FAIL] Stop if repository identity or HEAD verification fails.
    - [FAIL] Report the blocking fact. Do not invent missing state.

    ## OUTPUT

    - [OUTPUT] Return changed files, commit/PR state, verification state and blockers.

## Capability requirements

Skills should state capability requirements semantically rather than hard-code one implementation when several implementations can satisfy the requirement.

Prefer:

    [REQUIRE] Capability: browser.semantic

over:

    [REQUIRE] Playwright MCP server xyz must be installed

unless a specific implementation is itself part of the procedure.

This keeps Skill procedure separate from Project capability selection. A future Capability Profile can map semantic requirements to concrete authorized tools.

Example routing:

    browser.semantic
      -> Playwright
      -> OpenCLI
      -> UIA

A Skill describes the required capability and procedure. Project policy decides which concrete tool is authorized and preferred.

## Validation behavior

The analyzer checks only deterministic structural rules:

- SKILL.md parses correctly;
- declared profile is known;
- required sections exist once;
- required sections are not empty;
- PROCEDURE contains numbered steps;
- INPUT, PRECONDITION, VERIFY, FAIL and OUTPUT use explicit list items;
- headings inside fenced examples are ignored.

The analyzer does not attempt to infer whether arbitrary English prose is safe or correct.

It does not infer permissions.

It does not execute a Skill.

It does not mutate or normalize the original Skill.

## Advisory and strict use

Legacy Skill:

    analyze(content, strict=false)

Missing RCCL structure produces informational/advisory findings.

Explicit validation before adopting the profile:

    analyze(content, strict=true)

Missing RCCL structure is an error.

Profiled Skill:

    rakazo-profile: rccl-skill-v1

Profile rules are enforced as errors even when the caller does not separately request strict mode.

## ChatGPT helper

The Rakazo ChatGPT MCP exposes a read-only helper:

    rakazo_skill_profile

Actions:

- analyze — validate existing SKILL.md content.
- template — generate a canonical profiled SKILL.md scaffold.

The helper never saves or updates a Skill. Persistence still uses the existing Agent Skill create/update paths and their existing ownership rules.

## Relationship to Project RCCL

Project RCCL and RCCL Skill Profile solve different problems.

Project RCCL answers:

    What is true now?
    What Project am I in?
    What Resources and current state are relevant?
    What is the next explicit checkpoint?

RCCL Skill Profile answers:

    How should this reusable procedure be executed?
    What must be true before it starts?
    What proves success?
    What must never happen?
    What must happen on failure?

Do not store mutable HEADs, CI run ids or current PR status inside a reusable Skill. Put mutable state in Project Resources/Scratchpad and let the Skill read and verify it at execution time.
