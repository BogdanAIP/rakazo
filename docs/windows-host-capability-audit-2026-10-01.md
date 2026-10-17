# Windows Host capability audit

This source inventory describes Rakazo's native Windows extension surfaces. A capability in the contract is not proof that a particular installation has enabled or verified it.

| Surface | Source | Boundary |
| --- | --- | --- |
| Agent Skills | `packages/core/src/agent-skill.ts`, `apps/api/src/agent-skills.ts` | A reusable recipe does not itself grant host execution. |
| Taught Skills | `apps/api/src/taught-skills.ts` | Recording and replay require the existing authorization flow. |
| Installed connectors | `packages/adapters/src/installed-connectors.ts`, `lazy-tool-catalog.ts` | Discover and authorize installed tools before use. |
| Windows Host | `apps/windows-host/src/runtime.ts`, `native-process.ts`, `windows-files.ts`, `windows-gui.ts` | Pairing, identity, processes, files, browser, screen and input use typed contracts and opt-in capabilities. |
| ChatGPT MCP | `packages/adapters/src/chatgpt-mcp.ts`, `chatgpt-rakazo.ts` | The connected MCP child must match the intended source contract. |

## Validation gates

- Run the Windows Host unit suite and native smoke checks before pairing a new installation.
- File operations must preserve directory-handle containment, reparse-point rejection and regular single-link checks.
- Native handle conversion uses the running Node process's libuv exports. Do not substitute a separate CRT's file-descriptor table.
- Tests use disposable workspace directories. On Windows, an outside-directory junction provides a privilege-free traversal fixture.
- Pair through the existing owner flow. Start with process execution, file mutation and GUI capabilities disabled; enable only explicitly authorized capabilities after their checks pass.
- Pairing tokens and host credentials belong in the existing protected store, never in documentation, command logs or screenshots.
- Inspect the existing tunnel before changing its MCP command. Verify process ownership and preserve its registered identity instead of creating a second control plane.
- Use placeholders such as `C:/Users/<user>/rakazo` in public examples. Keep installation-specific paths, account details, tunnel identifiers, process inventories and operational transcripts outside the public repository.

## Architecture

Reuse the existing Market Resolver, Skills, connector catalog and computer contracts. Add app-specific adapters only for a measured capability gap. Contract availability, passing tests, pairing, heartbeat and an end-to-end authorized action are separate readiness gates.

## Native command policy

Native processes require both the explicit process capability and a local `native-process-policy.json` in the host state directory. Missing, empty or invalid policies disable advertisement and execution. The owner provisions version 1 with `commands`, each containing an exact `botId`, relative `cwd`, and complete `argv` beginning with an absolute executable path. There are no argument wildcards, prefix matches or remote policy mutation commands. Changes take effect on the next request.

Each approved command is trusted native code running with the Windows user's permissions. The workspace check constrains its working directory; it is not filesystem isolation. Approve only reviewed fixed commands, including any scripts they load. Arbitrary shell or interpreter input requires a separate OS isolation boundary. Child processes receive only Windows startup paths and temporary-directory settings; host tokens, connection secrets and Node injection options are excluded.
