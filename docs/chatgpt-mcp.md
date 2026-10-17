# ChatGPT MCP integration

> **Architecture roadmap:** [ChatGPT + Rakazo roadmap](./chatgpt-rakazo-roadmap.md) is the authoritative plan for the direct `ChatGPT Plus -> Plugin R -> Rakazo -> physical Windows` architecture, Plugin Extensions/MCP Apps UI, MCP Events, persistent jobs, Plus/Codex usage policy, and the staged removal of OpenResearch from the runtime path.


Rakazo can be used as a full ChatGPT plugin surface through OpenAI Secure MCP Tunnel without exposing the Rakazo API publicly.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> local tunnel-client
  -> stdio: node node_modules/tsx/dist/cli.mjs packages/adapters/src/chatgpt-mcp.ts
  -> Rakazo RPC API on 127.0.0.1:3100
  -> Rakazo bots, threads, computers, memory, routines, skills, integrations, artifacts, voice, and providers
```

The MCP server does not duplicate Rakazo features. It imports Rakazo's existing runtime `appContract` and discovers procedures directly from that contract. Input and output Zod schemas are converted to JSON Schema, so ChatGPT can inspect exact procedure fields without maintaining a second API definition.

Instead of registering hundreds of MCP tools, it exposes six generic tools plus two graphical computer tools:

- `rakazo_procedures` — discover the complete current appContract surface.
- `rakazo_describe` — inspect the live input/output JSON Schema for one procedure.
- `rakazo_read` — invoke procedures classified as read-only.
- `rakazo_write` — invoke non-destructive mutations.
- `rakazo_destructive` — invoke destructive/high-consequence mutations.
- `rakazo_thread_events` — collect bounded live events from `threads/subscribe`.
- `rakazo_computer_observe` — return a Rakazo desktop screenshot as MCP image content.
- `rakazo_computer_act` — acquire the existing user-control lease, batch desktop input, and optionally return the resulting screenshot.

The MCP server validates the requested procedure against the current appContract before delivery, so a procedure cannot be smuggled through the wrong tool class. The two graphical tools are specialized because screenshots must remain image content instead of being flattened into JSON/base64 text.

### ChatGPT as the computer brain

The graphical path does not require Rakazo to call an LLM. A normal ChatGPT conversation can use Rakazo as the stateful execution environment:

```text
ChatGPT
  -> rakazo_computer_observe
  -> screenshot
  -> ChatGPT chooses the next action
  -> rakazo_computer_act
  -> Rakazo Computer
  -> screenshot
  -> repeat
```

`rakazo_computer_act` uses Rakazo's existing `computer/takeover` and `computer/input` authorization path rather than bypassing computer-control leases. Other Rakazo capabilities remain available through the generic tools, so the same ChatGPT conversation can combine the graphical desktop with memory, files, integrations, routines, artifacts, and other appContract procedures.

### Concurrent ChatGPT chats: physical Chrome browser sessions

The previous computer/browser implementation used one OpenCLI session derived
only from botId. Multiple ChatGPT chats share the ChatGPT Windows bot, so that
name was unsafe: one chat could navigate or close another chat's active page.

The physical Windows Host now mints a separate **opaque bearer token** for every
explicit browser task. The current stdio Plugin R transport does NOT provide
a trusted ChatGPT conversation ID. Never claim automatic per-chat identity
or construct an OpenCLI session name from botId alone.

For EACH chat/task:

1. Use computer/takeover for the existing ChatGPT Windows bot if its user control
   lease is not active. Do not create another Host or tunnel.
2. Call rakazo_destructive with procedure "computer/browser" and an input
   containing the botId and request { command: "open" }. Retain the returned
   sessionToken privately in this chat/task.
3. Pass that same sessionToken inside the request with every navigate,
   snapshot and act command.
4. At the end of the task, close using only that sessionToken. Never close
   by Chrome group title, bot ID, guessed session name or another task's token.
5. If a token is lost, expires or the Host restarts, open again instead of
   reconstructing one. Host-side idle-token expiry is 30 minutes; OpenCLI has
   its own native idle tab expiry. Page persistence past either lifetime is
   not guaranteed.

Session operations are authorized by the normal Rakazo API actor and user
computer-control lease. The token provides per-task browser isolation, not
a platform-attested conversation identity. One physical desktop, cursor and
keyboard remain shared: chats must coordinate GUI input rather than driving
mouse/keyboard simultaneously.

The installed OpenCLI Chrome profile is reused. OPENCLI_WINDOW remains
foreground so the owner can watch navigation. OpenCLI may deliberately keep a
blank reusable group/tab after close; closing a scoped session does NOT prove
Chrome removed the visible group. Never delete groups only by title or close
user tabs. Removing leftover owned empty groups needs a separately verified
ownership-aware OpenCLI extension lifecycle improvement; global Chrome/group
cleanup is NOT enabled in Rakazo.

After deploying an appContract change, restart the original registered
Plugin R MCP process through its existing ownership-controlled lifecycle:
an already-running borrowed MCP process still has its previous contract in
memory and may report a stale rakazo_describe schema. Never create a second
tunnel or re-pair the original physical Host.

## Local configuration

The server reads configuration only from environment variables. Never commit these values.

- `RAKAZO_API_URL` — optional, defaults to `http://127.0.0.1:3100`.
- `RAKAZO_ORIGIN` — optional, defaults to `http://127.0.0.1:5173`.
- `RAKAZO_SESSION_TOKEN` — Better Auth session token used as a Bearer token. The launcher should obtain this through the authenticated local handoff below; setting it manually is a development fallback only.
- `RAKAZO_SPACE_ID` — optional Space selection.

### Session handoff

A normal Rakazo browser session already contains the Better Auth session token, but users should not copy it manually. A local launcher can obtain it without reading browser cookies:

1. Bind a one-shot HTTP listener on a random loopback port and generate a cryptographically random state value.
2. Open `/chatgpt/session?callback=http://127.0.0.1:<port>/callback&state=<state>` on the configured `RAKAZO_ORIGIN`.
3. Rakazo requires an existing signed-in session and explicit user confirmation.
4. The page POSTs `{ state, token }` to the loopback callback. The token is never rendered or placed in a URL.
5. The launcher verifies the state, stores the token in OS-protected storage, and supplies it to the MCP child as `RAKAZO_SESSION_TOKEN`.

The handoff accepts only `http://localhost|127.0.0.1|[::1]:<high-port>/callback` targets and rejects duplicate, weak, or non-loopback parameters.

For manual development only:

```bash
RAKAZO_SESSION_TOKEN=... pnpm chatgpt:mcp
```

For OpenAI Secure MCP Tunnel, do not put a package-manager wrapper in the stdio path: package managers may write banners to stdout and corrupt MCP JSON-RPC framing. Start the MCP entry point directly, for example:

```text
node node_modules/tsx/dist/cli.mjs packages/adapters/src/chatgpt-mcp.ts
```

Rakazo and the MCP server can remain loopback-only.

## Verification

```bash
pnpm --filter @rakazo/adapters test -- chatgpt-mcp
pnpm --filter @rakazo/adapters check
pnpm --filter @rakazo/web test -- chatgpt-session-handoff
pnpm --filter @rakazo/web check
```
