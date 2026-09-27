import process from "node:process";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { appContract } from "@rakazo/contracts";
import * as z from "zod";

export type ProcedureMode = "read" | "write" | "destructive" | "stream";

type ProcedureContract = {
  "~orpc": {
    inputSchema?: unknown;
    outputSchema?: unknown;
    route?: unknown;
    meta?: unknown;
    errorMap?: unknown;
  };
};

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const READ_ACTIONS = new Set([
  "all",
  "bootstrap",
  "catalog",
  "catalogSearch",
  "check",
  "credentials",
  "exportMarkdown",
  "files",
  "get",
  "getById",
  "head",
  "health",
  "list",
  "listArchived",
  "listSpace",
  "listVersions",
  "me",
  "messages",
  "prepare",
  "probeOpenAiCompatible",
  "providerConfig",
  "query",
  "readFile",
  "screenUrl",
  "snapshot",
  "status",
  "summary",
  "tools",
  "updates",
  "voices",
]);

const DESTRUCTIVE_ACTIONS = new Set([
  "apply",
  "archive",
  "cancelOAuth",
  "clear",
  "disconnect",
  "disconnectProvider",
  "leave",
  "remove",
  "reset",
  "revoke",
  "rotateWebhookSecret",
  "stop",
  "unregisterPush",
  "unlink",
]);

function isProcedureContract(value: unknown): value is ProcedureContract {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  if (!("~orpc" in value)) return false;
  const definition = value["~orpc"];
  return typeof definition === "object" && definition !== null && "errorMap" in definition;
}

function collectProcedureEntries(
  node: unknown,
  prefix: string[] = [],
  output: Array<{ procedure: string; contract: ProcedureContract }> = [],
): Array<{ procedure: string; contract: ProcedureContract }> {
  if (isProcedureContract(node)) {
    output.push({ procedure: prefix.join("/"), contract: node });
    return output;
  }

  if (typeof node !== "object" || node === null) return output;
  for (const [key, value] of Object.entries(node)) {
    collectProcedureEntries(value, [...prefix, key], output);
  }
  return output;
}

function procedureContract(procedure: string): ProcedureContract {
  const found = collectProcedureEntries(appContract).find((entry) => entry.procedure === procedure);
  if (!found) throw new Error(`Unknown Rakazo procedure: ${procedure}`);
  return found.contract;
}

function zodJsonSchema(schema: unknown, io: "input" | "output"): Record<string, unknown> | null {
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) return null;
  if (!("_zod" in schema)) return null;

  try {
    return z.toJSONSchema(schema as z.ZodType, {
      io,
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function discoverProcedurePaths(): string[] {
  return collectProcedureEntries(appContract)
    .map((entry) => entry.procedure)
    .sort();
}

export function classifyProcedure(procedure: string): ProcedureMode {
  if (procedure === "threads/subscribe") return "stream";

  const action = procedure.split("/").at(-1) ?? "";
  if (DESTRUCTIVE_ACTIONS.has(action)) return "destructive";
  if (READ_ACTIONS.has(action)) return "read";
  return "write";
}

export async function loadProcedureCatalog(): Promise<
  Array<{ procedure: string; mode: ProcedureMode }>
> {
  return discoverProcedurePaths().map((procedure) => ({
    procedure,
    mode: classifyProcedure(procedure),
  }));
}

export async function describeProcedure(procedure: string): Promise<{
  procedure: string;
  mode: ProcedureMode;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}> {
  const contract = procedureContract(procedure);
  return {
    procedure,
    mode: classifyProcedure(procedure),
    inputSchema: zodJsonSchema(contract["~orpc"].inputSchema, "input"),
    outputSchema: zodJsonSchema(contract["~orpc"].outputSchema, "output"),
  };
}

function apiBase(): string {
  return (process.env.RAKAZO_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
}

function rpcHeaders(): Headers {
  const token = process.env.RAKAZO_SESSION_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "RAKAZO_SESSION_TOKEN is not set. Supply a Rakazo Better Auth session token to the tunnel process.",
    );
  }

  const headers = new Headers({
    authorization: `Bearer ${token}`,
    origin: process.env.RAKAZO_ORIGIN ?? "http://127.0.0.1:5173",
  });
  const spaceId = process.env.RAKAZO_SPACE_ID?.trim();
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  return headers;
}

type DynamicRpcProcedure = (
  input?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

let rpcClient: unknown;

function rakazoRpcClient(): unknown {
  if (rpcClient) return rpcClient;

  rpcClient = createORPCClient(
    new RPCLink({
      url: () => `${apiBase()}/rpc`,
      headers: () => rpcHeaders(),
      fetch: async (request, init) => {
        const response = await fetch(request, init);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Rakazo response exceeds ${MAX_RESPONSE_BYTES} bytes`);
        }
        return response;
      },
    }),
  );
  return rpcClient;
}

function rpcProcedure(procedure: string): DynamicRpcProcedure {
  procedureContract(procedure);

  let node = rakazoRpcClient();
  for (const segment of procedure.split("/")) {
    if ((typeof node !== "object" && typeof node !== "function") || node === null) {
      throw new Error(`Rakazo RPC client has no procedure: ${procedure}`);
    }
    node = (node as Record<string, unknown>)[segment];
  }

  if (typeof node !== "function") {
    throw new Error(`Rakazo RPC client has no procedure: ${procedure}`);
  }
  return node as DynamicRpcProcedure;
}

export async function callRakazoRpc(
  procedure: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const contract = procedureContract(procedure);
  const callable = rpcProcedure(procedure);
  const payload = contract["~orpc"].inputSchema === undefined ? undefined : input;
  return callable(payload);
}

type EventTarget = { botId: string } | { groupId: string };

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

export async function collectThreadEvents(options: {
  target: EventTarget;
  cursor: number;
  timeoutMs: number;
  maxEvents: number;
}): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const events: unknown[] = [];

  try {
    const stream = await rpcProcedure("threads/subscribe")(
      { ...options.target, cursor: options.cursor },
      { signal: controller.signal },
    );
    if (!isAsyncIterable(stream)) {
      throw new Error("Rakazo threads/subscribe did not return an event iterator");
    }

    try {
      for await (const event of stream) {
        events.push(event);
        if (events.length >= options.maxEvents || controller.signal.aborted) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

