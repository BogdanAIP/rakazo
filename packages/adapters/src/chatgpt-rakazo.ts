import process from "node:process";
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

function authHeaders(accept = "application/json"): Headers {
  const token = process.env.RAKAZO_SESSION_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "RAKAZO_SESSION_TOKEN is not set. Supply a Rakazo Better Auth session token to the tunnel process.",
    );
  }

  const headers = new Headers({
    accept,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    origin: process.env.RAKAZO_ORIGIN ?? "http://127.0.0.1:5173",
  });
  const spaceId = process.env.RAKAZO_SPACE_ID?.trim();
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  return headers;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`Rakazo response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`Rakazo response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return text;
}

export async function callRakazoRpc(
  procedure: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(`${apiBase()}/rpc/${procedure}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ json: input }),
  });

  const text = await boundedText(response);
  let payload: { json?: unknown; error?: { message?: string } };
  try {
    payload = text ? (JSON.parse(text) as typeof payload) : {};
  } catch {
    throw new Error(`Rakazo RPC ${procedure} returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || payload.error) {
    throw new Error(
      payload.error?.message ?? `Rakazo RPC ${procedure} failed (HTTP ${response.status})`,
    );
  }

  return payload.json;
}

type EventTarget = { botId: string } | { groupId: string };

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
    const response = await fetch(`${apiBase()}/rpc/threads/subscribe`, {
      method: "POST",
      headers: authHeaders("text/event-stream"),
      body: JSON.stringify({ json: { ...options.target, cursor: options.cursor } }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      await response.text().catch(() => "");
      throw new Error(`Rakazo thread subscription failed (HTTP ${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (events.length < options.maxEvents && !controller.signal.aborted) {
      const chunk = await reader.read().catch((error: unknown) => {
        if (controller.signal.aborted) return null;
        throw error;
      });
      if (!chunk || chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");

        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { json?: unknown; error?: { message?: string } };
          if (parsed.error) throw new Error(parsed.error.message ?? "Rakazo event stream error");
          if (parsed.json !== undefined) events.push(parsed.json);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }

        if (events.length >= options.maxEvents) break;
      }
    }

    await reader.cancel().catch(() => undefined);
    return events;
  } finally {
    clearTimeout(timer);
  }
}
