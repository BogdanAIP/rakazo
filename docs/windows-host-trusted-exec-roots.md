# Windows Host: explicitly trusted process working directories

The physical Windows Host deliberately restricts `computer/exec.cwd` to a bot's
private workspace by default. A repository elsewhere on disk does **not** become
a valid `cwd` merely because the bot can name it.

For a repo explicitly approved by the person operating the Windows Host, the host
process may be configured with `RAKAZO_WINDOWS_TRUSTED_EXEC_ROOTS_JSON`.
It is a JSON object mapping **exact bot IDs** to lists of absolute local paths.
Example (the actual path and bot ID must be verified locally):

```json
{
  "bot-id": [
    "C:\\Users\\owner\\trusted-repository"
  ]
}
```

This setting belongs to the host operator, not to an LLM message, project memory,
skill, or remote tool call. Apply it to the Windows Host's launch environment and
restart **only when other tasks/services can safely tolerate a restart**.
Malformed configuration prevents process backend initialization (fail closed).

Behavior:
- Relative `cwd` remains confined to the bot workspace.
- An absolute `cwd` is allowed only within a root explicitly registered for
  that same bot. Directories must exist; symbolic links and Windows junctions
  within the selected path are rejected.
- Unregistered roots, other bots' roots, path traversal, network shares and
  drive/filesystem roots remain disallowed as trusted entries.
- `computer/files`, `computer/readFile` and host file mutation do **not**
  gain access to a registered process working directory. They still use the
  existing separate workspace rules.
- The API maps a small allowlist of expected path validation failures to
  `BAD_REQUEST` with understandable messages. Unknown failures remain
  internal rather than exposing host implementation details.

## Security boundaries

**This is not a filesystem sandbox.** A Windows process launched with
`computer/exec` runs with the actual Windows Host user's permissions. The
`cwd` allowlist controls the starting directory, not the command's ability to
open another path. Keep machine/process control authorization, short command
timeouts, protected secrets, human approval, and repo/worktree verification.
Do not point the configuration at a home folder, operating system directory,
credential store, or broad volume root.

No change here grants browser access, authorizes a tool, re-pairs the Windows
Host, or automatically updates a running instance. Enable this only when the
explicit host owner has chosen the exact repository and bot.
