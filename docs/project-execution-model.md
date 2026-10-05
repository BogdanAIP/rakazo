# Project execution model

Rakazo separates durable project state from execution identities and physical workspaces.

## Canonical roles

- **Project** is the source of truth for a long-lived body of work.
  - `Project.memory`: durable architecture, decisions, invariants, roadmap, milestone summaries. It is context, not executable authority.
  - `ProjectResource`: live references such as repositories, branches, pull requests, bots, runtimes and worktrees.
  - project-scoped Scratchpad items: current checkpoint, live CI state and exact next action.
- **Bot** is an execution role and policy boundary. A project does not require a dedicated bot.
- **Computer** is an execution environment (for example a physical Windows Host or a team Docker computer).
- **Workspace / Git worktree** is a physical checkout on a computer.
- **Run** is an ephemeral execution instance.

A bot must not be created only to obtain project memory isolation. Create a bot when the work needs a distinct execution policy, permissions, routines, model/runtime configuration, or autonomous identity.

## Bootstrap

Ordinary ChatGPT conversations should bootstrap by project, not by bot, when the user's intent names a project.

`rakazo_project_bootstrap({ projectId | projectSlug })` is the project-centric entry point. It is independent of bot selection and returns:

- canonical project memory;
- project resources;
- open project tasks;
- linked bots derived from `rakazo.bot` resources and task `botId` values, with the link source exposed;
- worktree resources;
- active runs only for explicit `rakazo.bot` resources; task-only shared bots are not treated as project-owned runs;
- available skills and installed capabilities.

`rakazo_context_bootstrap({ botId, ... })` remains bot-centric for execution-specific context.

## Resource conventions

Recommended project resource kinds:

- `github.repo`
- `github.pr`
- `git.branch`
- `rakazo.bot`
- `workspace.worktree`
- runtime/plugin-specific kinds when needed

A worktree resource should use the physical checkout path as `ref` and metadata similar to:

```json
{
  "repo": "BogdanAIP/rakazo",
  "branch": "feature/example",
  "computerBotId": "<execution computer anchor>",
  "role": "development"
}
```

The resource records intended state. Live Git/Computer state must still be verified before writes.

## Write discipline and concurrency

- Mutable GitHub/CI HEAD values belong in resources or Scratchpad, not bot instructions.
- Bot instructions contain stable role, permissions, prohibitions and operating rules.
- Update `Project.memory` only for durable milestone information and use `expectedMemoryRevision`.
- Parallel workstreams use separate Scratchpad items.
- Parallel code work uses separate branches/worktrees.
- Never let two conversations silently overwrite the same project-memory revision or the same worktree.
- Verify live GitHub and computer state before state-changing operations.

## Worktree lifecycle

The intended helper is bounded and project-aware rather than a general shell alias:

1. verify project, repository resource, computer and requested branch/path;
2. require absolute repository/worktree paths and inspect `git worktree list --porcelain`;
3. for a new local branch, require an exact 40-character commit SHA already verified from live GitHub state; fetch only that exact commit from the verified project origin if the object is absent locally;
4. create or verify the exact worktree using direct Git argv through the existing Computer execution path;
5. fail closed on path/branch/repository mismatch;
6. register or refresh the `workspace.worktree` project resource only after Git verification.

The helper must not introduce a new unrestricted process or shell capability and must preserve normal Computer control-lease rules.

## Current examples

- **Rakazo**: project state plus shared physical `ChatGPT Windows` infrastructure.
- **Rakazo Trading**: project plus a dedicated Trading bot because the PAPER-only safety and execution policy is distinct; its local code checkout should still be represented separately as a worktree resource on the physical computer.
- **ComicChat**: project does not require a dedicated bot unless a distinct execution identity becomes useful.
- **AIHOT**: project memory/resources/tasks are sufficient for development; create collector/publisher bots only when those autonomous execution roles are introduced.
