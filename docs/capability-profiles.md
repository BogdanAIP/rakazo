# Project Capability Profiles v1

Capability Profiles let a Rakazo Project describe the semantic capabilities it needs without exposing a large flat tool set or hard-coding one MCP implementation into every Skill.

The model is:

    Project
      -> capability.profile
      -> semantic requirement
      -> native Project proof or explicit capability.binding
      -> existing Rakazo authorization/policy
      -> concrete tool execution

Profiles do not grant permissions by themselves.

## Safety boundary

A Capability Profile does not:

- install a capability;
- start OAuth;
- assign an MCP server to a Bot;
- broaden a GitHub Project grant;
- acquire a Computer control lease;
- approve a destructive action;
- execute a capability.

The resolver is read-only.

A requirement reported as ready or available still executes through the existing Rakazo policy and authorization path.

Missing capabilities fail closed and include only a discovery query.

## Project resource convention

No database migration is required. V1 uses existing Project Resources.

One active profile is stored as:

    kind: capability.profile
    ref: active

Metadata is a versioned snapshot:

    {
      "schemaVersion": "capability-profile-v1",
      "catalogVersion": 1,
      "profile": "aihot",
      "required": ["repo.read", "research.web"],
      "optional": ["repo.write", "browser.semantic"],
      "denied": []
    }

The snapshot is materialized at assignment time. A future change to the built-in catalog does not silently change an existing Project.

## Explicit capability binding

External semantic requirements can be linked to one exact currently authorized Rakazo capability tool with:

    kind: capability.binding
    ref: browser.semantic

Example metadata:

    {
      "schemaVersion": "capability-binding-v1",
      "botId": "bot-id",
      "tool": "playwright_snapshot",
      "route": {
        "connectorId": "installed",
        "toolName": "playwright_snapshot",
        "resourceId": "capability-install-id",
        "catalogGroup": "Playwright"
      }
    }

The resolver verifies the exact tool and route against the current authorized capabilities/tools catalog.

If the route no longer matches, the binding is stale.

V1 does not infer an external binding from a similar tool name.

## Built-in semantic requirements

V1 defines:

- repo.read
- repo.write
- browser.semantic
- browser.debug
- browser.visual
- computer.exec
- computer.files
- research.web
- documents.read
- citations
- media.capture
- messaging.telegram
- market.data
- defi.data
- database.read

Each requirement has a short description and a discovery query.

These names are intended to be used by RCCL Skill Profile PRECONDITION entries, for example:

    [REQUIRE] Capability: browser.semantic

A Skill should request a semantic capability instead of naming a concrete MCP implementation unless that implementation is intrinsically required.

## Built-in profile templates

### web-development

Required:

- repo.read

Optional:

- repo.write
- computer.files
- computer.exec
- browser.semantic
- browser.debug
- browser.visual

### research

Required:

- research.web
- citations

Optional:

- documents.read
- browser.semantic
- browser.visual

Denied:

- repo.write

### aihot

Required:

- repo.read
- research.web

Optional:

- repo.write
- browser.semantic
- browser.debug
- browser.visual
- computer.files
- computer.exec
- media.capture
- messaging.telegram
- citations

### trading-research

Required:

- repo.read
- market.data

Optional:

- repo.write
- research.web
- defi.data
- database.read
- citations

Denied:

- messaging.telegram

The trading profile is a research profile. It does not authorize live trading.

## Resolver states

The read-only resolver reports each requirement as one of:

- ready — exact Project proof or exact live explicit binding exists;
- available — a linked running execution Computer exists, but normal control/approval policy still applies;
- missing — no verified implementation is available;
- denied — the active profile explicitly denies the requirement;
- stale — an explicit binding exists but cannot be verified against the current authorized tool catalog.

V1 automatically recognizes only narrow Project-native facts:

- repo.read is ready when the Project has a github.repo resource;
- repo.write is ready only when a Project github.repo has githubAccess=autonomous_write;
- computer.exec, computer.files and browser.visual can be available when a linked Project execution Bot has a running accessible Computer.

All other external semantic capabilities require an explicit capability.binding before the resolver calls them ready.

## ChatGPT surface

Read-only helper:

    rakazo_capability_profile

Actions:

- catalog — return the built-in profile catalog and semantic requirement registry;
- resolve — resolve one Project active profile against current state.

Write helper:

    rakazo_capability_profile_assign

The assign helper:

1. validates a built-in profile;
2. applies explicit addRequired/addOptional/deny overrides;
3. materializes a versioned snapshot;
4. upserts only capability.profile/active.

It does not install, authenticate, bind or execute a tool.

## RCCL bootstrap

The Project Context Compiler recognizes a valid active capability.profile resource and emits compact RCCL statements such as:

    [CAPABILITY] profile="aihot"; schemaVersion="capability-profile-v1"; catalogVersion="1"
    [CAPABILITY] requirement="repo.read"; level="required"
    [CAPABILITY] requirement="browser.semantic"; level="optional"

Malformed active profile metadata produces a BLOCKER in the compiled context.

## Relationship to Skills

RCCL Skill Profile describes the reusable procedure.

Capability Profile describes the Project's allowed/desired semantic tool surface.

Example:

    Skill PRECONDITION:
      [REQUIRE] Capability: browser.semantic

    Project capability.profile:
      browser.semantic = optional

    Project capability.binding:
      browser.semantic -> exact Playwright tool route

    Resolver:
      verifies the binding

    Execution:
      uses normal Rakazo capability policy and approval gates

This separation lets a Skill remain stable when the concrete browser implementation changes.

## Next phases

V1 intentionally does not automatically install or bind discovered tools.

Later phases can add:

- reviewed binding creation;
- nested MCP catalog resolution;
- profile-aware tool ranking;
- Project-specific capability discovery;
- policy-based fallback chains such as API/MCP -> Playwright -> DevTools -> OpenCLI -> UIA -> vision;
- routine/event triggers that request Skills which declare semantic capability requirements.
