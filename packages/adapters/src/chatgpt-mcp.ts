import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadChatGptContext,
  loadChatGptProjectContext,
  searchChatGptCapabilities,
} from "./chatgpt-context.js";
import type { ProcedureMode } from "./chatgpt-rakazo.js";
import { manageProjectWorktree } from "./chatgpt-worktree.js";
import {
  actRakazoComputer,
  callRakazoRpc,
  collectThreadEvents,
  describeProcedure,
  loadProcedureCatalog,
  observeRakazoComputer,
  type RakazoComputerObservation,
} from "./chatgpt-rakazo.js";

const server = new McpServer({
  name: "rakazo-chatgpt",
  version: "0.1.0",
});

const callSchema = z.object({
  procedure: z.string().min(1).describe("Rakazo appContract procedure, for example bots/list"),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

const capabilityRouteSchema = z.object({
  connectorId: z.string().min(1).max(120),
  toolName: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(500).optional(),
  resourceRevision: z.union([z.string(), z.number()]).optional(),
  catalogGroup: z.string().max(200).optional(),
});

const capabilityCallSchema = z.object({
  botId: z.string().min(1),
  tool: z.string().min(1).max(300),
  route: capabilityRouteSchema,
  args: z.record(z.string(), z.unknown()).default({}),
  executionId: z.string().min(1).max(160).optional(),
});
const projectWorktreeSchema = z
  .object({
    action: z.enum(["list", "verify", "ensure"]),
    projectId: z.string().min(1),
    computerBotId: z.string().min(1),
    repository: z
      .string()
      .min(3)
      .max(300)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    repoPath: z.string().min(1).max(4_096),
    worktreePath: z.string().min(1).max(4_096).optional(),
    branch: z.string().min(1).max(240).optional(),
    baseRef: z.string().min(1).max(500).optional(),
    role: z.string().min(1).max(120).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action !== "list" && !input.worktreePath) {
      ctx.addIssue({
        code: "custom",
        message: "worktreePath is required for verify/ensure",
        path: ["worktreePath"],
      });
    }
    if (input.action === "ensure" && !input.branch) {
      ctx.addIssue({
        code: "custom",
        message: "branch is required for ensure",
        path: ["branch"],
      });
    }
  });

const computerActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["click", "move", "down", "up"]),
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
    button: z.enum(["left", "right"]).optional(),
  }),
  z.object({
    kind: z.literal("type"),
    text: z.string().max(100_000),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(100),
    modifiers: z.array(z.string().min(1).max(32)).max(4).optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    kind: z.literal("wait"),
    ms: z.number().int().min(0).max(5_000),
  }),
]);

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function computerObservationResult(
  observation: RakazoComputerObservation,
  note: string,
  previousFrameId?: string,
) {
  const unchanged = previousFrameId === observation.frameId;
  const metadata = {
    frameId: observation.frameId,
    capturedAt: observation.capturedAt,
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
    unchanged,
  };
  return {
    content: [
      { type: "text" as const, text: `${note}\n${JSON.stringify(metadata)}` },
      ...(unchanged
        ? []
        : [
            {
              type: "image" as const,
              data: observation.imageBase64,
              mimeType: observation.mimeType,
            },
          ]),
    ],
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
  "rakazo_context_bootstrap",
  {
    title: "Load shared Rakazo context",
    description:
      "Read-only cross-chat context: global Memory plus project index, open Scratchpad, Skills, Runs, Routines and installed capabilities. Optionally select projectId or projectSlug to load that project memory, resources and open tasks in the same call. No second model.",
    inputSchema: z
      .object({
        botId: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        projectSlug: z.string().min(1).max(80).optional(),
      })
      .superRefine((input, ctx) => {
        if (input.projectId && input.projectSlug) {
          ctx.addIssue({
            code: "custom",
            message: "Specify only one of projectId or projectSlug",
            path: ["projectId"],
          });
        }
      }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ botId, projectId, projectSlug }) =>
    textResult(
      await loadChatGptContext(callRakazoRpc, botId, {
        projectId,
        projectSlug,
      }),
    ),
);

server.registerTool(
  "rakazo_project_bootstrap",
  {
    title: "Load selected Rakazo project context",
    description:
      "Read-only project-centric bootstrap for ordinary ChatGPT. Select exactly one projectId or projectSlug and receive the canonical project memory, resources, open tasks, linked execution bots, worktrees and active project runs. Does not require selecting a bot and does not invoke a second model.",
    inputSchema: z
      .object({
        projectId: z.string().min(1).optional(),
        projectSlug: z.string().min(1).max(80).optional(),
      })
      .superRefine((input, ctx) => {
        const selectors = Number(Boolean(input.projectId)) + Number(Boolean(input.projectSlug));
        if (selectors !== 1) {
          ctx.addIssue({
            code: "custom",
            message: "Specify exactly one of projectId or projectSlug",
            path: ["projectId"],
          });
        }
      }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ projectId, projectSlug }) =>
    textResult(
      await loadChatGptProjectContext(callRakazoRpc, {
        projectId,
        projectSlug,
      }),
    ),
);

server.registerTool(
  "rakazo_project_worktree",
  {
    title: "Manage a project Git worktree",
    description:
      "Bounded project-aware Git worktree helper. Lists, verifies, or ensures one worktree using the existing Rakazo Computer control lease and computer/exec. It verifies the project's exact github.repo resource and the local origin before Git operations, never uses --force, and registers workspace.worktree only after successful verification.",
    inputSchema: projectWorktreeSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => textResult(await manageProjectWorktree(callRakazoRpc, input)),
);

server.registerTool(
  "rakazo_capability_search",
  {
    title: "Discover installed and public capabilities",
    description:
      "Read-only discovery. Search installed capabilities and optionally public integrations without installing, authorizing or executing them.",
    inputSchema: z.object({
      query: z.string().max(200).default(""),
      includePublic: z.boolean().default(false),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, includePublic }) =>
    textResult(await searchChatGptCapabilities(callRakazoRpc, query, includePublic)),
);
server.registerTool(
  "rakazo_project_context",
  {
    title: "Load Rakazo project context",
    description:
      "Read one persistent Rakazo project with its project memory, resources and open tasks. Use the project list from rakazo_context_bootstrap, or discover projects/list through rakazo_read.",
    inputSchema: z.object({ projectId: z.string().min(1) }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ projectId }) => textResult(await callRakazoRpc("projects/context", { projectId })),
);

server.registerTool(
  "rakazo_tool_search",
  {
    title: "Search authorized Rakazo tools",
    description:
      "Search the tools currently authorized through Rakazo across installed MCP/API/GraphQL and assigned connector providers. Returns bounded tool schemas and authoritative routing metadata without executing anything.",
    inputSchema: z.object({
      botId: z.string().min(1),
      query: z.string().max(200).default(""),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ botId, query, limit }) =>
    textResult(await callRakazoRpc("capabilities/tools", { botId, query, limit })),
);

server.registerTool(
  "rakazo_tool_read",
  {
    title: "Run a read-only Rakazo tool",
    description:
      "Invoke one previously discovered Rakazo capability only when its authoritative tool metadata declares it read-only. Rediscovery and route validation happen server-side before execution.",
    inputSchema: capabilityCallSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => textResult(await callRakazoRpc("capabilities/read", input)),
);

server.registerTool(
  "rakazo_tool_execute",
  {
    title: "Run a Rakazo capability",
    description:
      "Invoke one previously discovered authorized Rakazo capability, including write-capable external tools. The authoritative route is rediscovered and validated by Rakazo before execution.",
    inputSchema: capabilityCallSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => textResult(await callRakazoRpc("capabilities/execute", input)),
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
    if (procedure === "computer/observe") {
      throw new Error(
        "Use rakazo_computer_observe for computer/observe so the screenshot stays MCP image content",
      );
    }
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
      "Call a destructive or high-consequence Rakazo appContract procedure. For concurrent ChatGPT Chrome tasks: use computer/browser with request.command=open to obtain a private sessionToken; pass it on navigate/snapshot/act, then close ONLY that token. Never share botId-only browser sessions or close Chrome groups by title.",
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
  "rakazo_computer_observe",
  {
    title: "Observe Rakazo computer",
    description:
      "Observe a running Rakazo bot computer and return the current desktop screenshot as MCP image content. Use this for the visual agent loop instead of calling computer/observe through rakazo_read.",
    inputSchema: z.object({
      botId: z.string().min(1),
      previousFrameId: z.string().min(1).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ botId, previousFrameId }) =>
    computerObservationResult(
      await observeRakazoComputer(botId),
      "Rakazo computer observed",
      previousFrameId,
    ),
);

server.registerTool(
  "rakazo_computer_act",
  {
    title: "Act on Rakazo computer",
    description:
      "Take the existing Rakazo user-control lease, execute up to 24 desktop actions on a running bot computer, and by default return the resulting screenshot. This drives Rakazo Computer directly and does not invoke a Rakazo model.",
    inputSchema: z.object({
      botId: z.string().min(1),
      actions: z.array(computerActionSchema).min(1).max(24),
      observe: z.boolean().default(true),
      previousFrameId: z.string().min(1).optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ botId, actions, observe, previousFrameId }) => {
    const result = await actRakazoComputer(botId, actions, { observe });
    if (!result.observation) return textResult({ completed: result.completed });
    return computerObservationResult(
      result.observation,
      `Completed ${result.completed} Rakazo computer action${result.completed === 1 ? "" : "s"}`,
      previousFrameId,
    );
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
