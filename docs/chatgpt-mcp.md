# ChatGPT MCP integration

Rakazo can be used as a full ChatGPT plugin surface through OpenAI Secure MCP Tunnel without exposing the Rakazo API publicly.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> local tunnel-client
  -> stdio: pnpm chatgpt:mcp
  -> Rakazo RPC API on 127.0.0.1:3100
  -> Rakazo bots, threads, computers, memory, routines, skills, integrations, artifacts, voice, and providers
```

The MCP server does not duplicate Rakazo features. It projects the existing `packages/contracts/src/rpc.ts` appContract and discovers procedures from that source at startup.

Instead of registering hundreds of MCP tools, it exposes six stable tools:

- `rakazo_procedures` — discover the complete current appContract surface.
- `rakazo_describe` — inspect the live contract signature for one procedure.
- `rakazo_read` — invoke procedures classified as read-only.
- `rakazo_write` — invoke non-destructive mutations.
- `rakazo_destructive` — invoke destructive/high-consequence mutations.
- `rakazo_thread_events` — collect bounded live events from `threads/subscribe`.

The MCP server validates the requested procedure against the current appContract before delivery, so a procedure cannot be smuggled through the wrong tool class.

## Local configuration

The server reads configuration only from environment variables. Never commit these values.

- `RAKAZO_API_URL` — optional, defaults to `http://127.0.0.1:3100`.
- `RAKAZO_ORIGIN` — optional, defaults to `http://127.0.0.1:5173`.
- `RAKAZO_SESSION_TOKEN` — required Better Auth session token used as a Bearer token.
- `RAKAZO_SPACE_ID` — optional Space selection.

Run from the repository root:

```bash
RAKAZO_SESSION_TOKEN=... pnpm chatgpt:mcp
```

For OpenAI Secure MCP Tunnel, configure the local stdio command as `pnpm chatgpt:mcp` and supply the environment variables to the tunnel process. Rakazo and the MCP server can remain loopback-only.

## Verification

```bash
pnpm --filter @rakazo/adapters test -- chatgpt-mcp
pnpm --filter @rakazo/adapters check
```
