import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ProcedureMode } from "./chatgpt-rakazo.js";
import {
  callRakazoRpc,
  collectThreadEvents,
  describeProcedure,
  loadProcedureCatalog,
} from "./chatgpt-rakazo.js";

const server = new McpServer({
  name: "rakazo-chatgpt",
  version: "0.1.0",
});

const callSchema = z.object({
  procedure: z.string().min(1).describe("Rakazo appContract procedure, for example bots/list"),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

async function assertProcedureMode(procedure: string, expected: ProcedureMode): Promise<void> {
  const catalog = await loadProcedureCatalog();
  const known = catalog.find((entry) => entry.procedure === procedure);
  if (!known) throw new Error(`Unknown Rakazo procedure: ${procedure}`);
  if (known.mode !== expected) {
    throw new Error(
      `Rakazo procedure ${procedure} is classified as ${known.mode}; use the matching Rakazo MCP tool`,
    );
  }
}

server.registerTool(
  "rakazo_procedures",
  {
    title: "Rakazo procedures",
    description:
      "List the current Rakazo appContract procedures and their ChatGPT access class. Use this to discover the full Rakazo surface without exposing hundreds of individual MCP tools.",
    inputSchema: z.object({
      query: z.string().optional().describe("Optional substring filter"),
      mode: z.enum(["read", "write", "destructive", "stream"]).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, mode }) => {
    const normalized = query?.trim().toLowerCase();
    const catalog = (await loadProcedureCatalog()).filter(
      (entry) =>
        (!mode || entry.mode === mode) &&
        (!normalized || entry.procedure.toLowerCase().includes(normalized)),
    );
    return textResult({ count: catalog.length, procedures: catalog });
  },
);

server.registerTool(
  "rakazo_describe",
  {
    title: "Describe Rakazo procedure",
    description:
      "Return the live appContract signature for one Rakazo procedure before calling it. Use this when you need the exact input/output shape.",
    inputSchema: z.object({
      procedure: z.string().min(1),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ procedure }) => textResult(await describeProcedure(procedure)),
);

server.registerTool(
  "rakazo_read",
  {
    title: "Rakazo read",
    description:
      "Call any read-only Rakazo appContract procedure. The server validates that the requested procedure is currently classified as read-only.",
    inputSchema: callSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ procedure, input }) => {
    await assertProcedureMode(procedure, "read");
    return textResult(await callRakazoRpc(procedure, input));
  },
);

server.registerTool(
  "rakazo_write",
  {
    title: "Rakazo write",
    description:
      "Call a non-destructive state-changing Rakazo appContract procedure. The server rejects read, destructive, and streaming procedures.",
    inputSchema: callSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ procedure, input }) => {
    await assertProcedureMode(procedure, "write");
    return textResult(await callRakazoRpc(procedure, input));
  },
);

server.registerTool(
  "rakazo_destructive",
  {
    title: "Rakazo destructive action",
    description:
      "Call a destructive or high-consequence Rakazo appContract procedure such as remove, revoke, stop, reset, clear, disconnect, archive, or updater apply.",
    inputSchema: callSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ procedure, input }) => {
    await assertProcedureMode(procedure, "destructive");
    return textResult(await callRakazoRpc(procedure, input));
  },
);

server.registerTool(
  "rakazo_thread_events",
  {
    title: "Rakazo thread events",
    description:
      "Collect a bounded batch of live Rakazo thread events from threads/subscribe. Use for progress, tool calls, subagents, and terminal run events.",
    inputSchema: z
      .object({
        botId: z.string().min(1).optional(),
        groupId: z.string().min(1).optional(),
        cursor: z.number().int().min(-1).default(-1),
        timeoutMs: z.number().int().min(250).max(60_000).default(5_000),
        maxEvents: z.number().int().min(1).max(100).default(30),
      })
      .refine((value) => Boolean(value.botId) !== Boolean(value.groupId), {
        message: "Provide exactly one of botId or groupId",
      }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ botId, groupId, cursor, timeoutMs, maxEvents }) => {
    const target = botId ? { botId } : { groupId: groupId! };
    return textResult(await collectThreadEvents({ target, cursor, timeoutMs, maxEvents }));
  },
);

async function main(): Promise<void> {
  const catalog = await loadProcedureCatalog();
  if (catalog.length === 0) throw new Error("Rakazo appContract contains no procedures");
  process.stderr.write(
    `rakazo-chatgpt MCP ready: ${catalog.length} procedures from the live appContract\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`rakazo-chatgpt MCP failed: ${message}\n`);
  process.exitCode = 1;
});
