# Market Resolver Engine v1 — onboarding new Skills and Resolvers

Status: selection preview, NOT a new executor. No tool is installed, authorized or invoked by this API.

## Core contract

Skill describes user intent; Resolver maps semanticKey to declarations; live Capability Hub and Computer lease determine available execution routes; existing Tool API executes; caller verifies result. Market indexing is never authority to execute.

The same engine handles the current 22 or a newly imported 23rd Resolver without changing case/switch code. It handles any new semanticKey with a versioned, validated binding and a live authorized match.

## Add a new Skill

1. Import pinned curated origin using existing market/importGithub: sourceRef, digest, license and provenance.
2. Check duplicates, trust, user purpose and dependencies. ORIGINAL is preserved.
3. Use existing market/adapt for optional reviewed RCCL, WRAPPED or HYBRID, followed by market/evaluate. Adaptation does not install an executable connector.
4. Bind the Skill to a semanticKey and select a Resolver; fail closed when capability is unavailable.
5. Save observed result, source revision and decision reason. Never infer faster performance from shorter context.

## Add a new Resolver or provider


1. Import a pinned Resolver JSON via existing Market import. Required: semanticKey and ordered implementations, with explicit binding only for executable candidates.
2. For an existing native route: binding {"type":"appContract","procedure":"computer/browser"} plus reference "rakazo:computer/browser". The trusted API must expose this route and the bot must own a valid Computer lease.
3. For an authorized connector: binding {"type":"connector","tool":"actual_name","connectorId":"mcp","toolName":"operation","resourceId":"exact_resource_if_any","resourceRevision":"revision_if_any","catalogGroup":"group_if_any"}. All route attributes must match live discovery.
4. Validate unique priorities, distinct bindings, original digest, semantic key and provenance. Do not promote duplicates or conflicting versions automatically.
5. Call market/resolve with botId, semanticKey, access ("read" or "interactive") and optional resolverEntryId. If multiple pinned versions share the key, pin one explicitly; otherwise the resolver rejects ambiguity.
6. Treat the response as a selection PLAN. Invoke via the existing computer/browser, computer/exec or capabilities/read/execute API with its normal independent security checks, then verify the output.

## Safety and rollout


- Read-only requests cannot select write-capable tools. No external provider can be inferred from matching names alone.
- CDP/Extension require opt-in; Browser v2 keeps Persistent then OpenCLI fallback inside its existing Router.
- New bindable components never require a new low-level executor, but new native procedures must first be implemented/authorized independently.
- Old Market entries stay pinned to their original source; editing a repository seed does not replace a live DB entry.
- Project-scoped activation pointers, durable selection traces and automatic execute/verify are **not** implemented in this v1 preview. Implement separately after tests and review.
