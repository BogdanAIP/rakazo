# ChatGPT MCP integration

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
