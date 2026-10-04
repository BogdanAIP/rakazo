# Project-scoped autonomous GitHub writes

Ordinary ChatGPT sessions can act autonomously in a specific GitHub repository
through the existing Plugin R -> Rakazo -> official GitHub MCP bridge.
No second tunnel or model is added.

## Grant

An authenticated Space owner selects an existing, non-archived Project and
upserts an existing github.repo resource with canonical ref BogdanAIP/rakazo
(or another explicitly authorized owner/repo). Set metadata fields:
- githubAccess: autonomous_write
- githubMcpServerId: ID of the assigned official GitHub MCP server

A github.repo resource without BOTH fields is not a write grant. GitHub MCP
allowAllTools means tool availability only, NOT autonomous scope.

Each write through capabilities/execute must specify projectId and use the
live-discovered route plus schema-valid args. Rakazo checks that the selected
project belongs to the current Space/user. The MCP connector rechecks project,
Space, user, matching grant and server ID immediately before GitHub's call.
Direct tools and lazy catalog connectors_execute_tool share the same guard.
Missing or stale permissions fail closed before a GitHub mutation.

## Scope and limits

Repository-confined writes can proceed autonomously: branches, files, Issues,
PRs, merge, workflow triggers, repository rulesets and explicitly reviewed
write tools. GitHub account privileges and branch protection still apply.

Account-/organization-wide, ambiguous, cross-repository and newly discovered
unreviewed write tools are denied by a repository-scoped grant. Secondary
cross-repository selectors and inconsistent owner/repo aliases are rejected.
Read-only tools remain accessible without an autonomous write grant.

This is enforced in the Rakazo backend, not by prompting the model. It does not
restrict an unrelated direct GitHub integration or effects of a GitHub Actions
workflow running with its own credentials.

## Deployment

1. Review PR/CI and update native Rakazo normally; preserve original R tunnel,
   Windows Host and unrelated local modifications.
2. Confirm capabilities/execute exposes optional projectId and policy tests pass.
3. Only AFTER updated server policy is live, upsert the two grant metadata keys.
4. Smoke test an allowed change in a dedicated branch, refusal of a different
   repository, read-only access and CI.
5. Revoke by removing grant metadata or archiving the project.

No DB migration and no new GitHub PAT are required for this policy.
