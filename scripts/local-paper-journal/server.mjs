import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectOfflinePositions } from "./offline-position-check.mjs";
import { createPaperStopControl } from "./paper-graceful-stop-runtime.mjs";

const PREFIX = "/linked-paper";
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function localOrigin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error("Journal gateway configuration invalid");
  return u.origin;
}

export function validateConfig(raw, env = process.env) {
  const keys = [
    "publicOrigin",
    "authOrigin",
    "authApi",
    "allowedUserId",
    "paperApi",
    "paperOrigin",
    "paperSpaceId",
    "procedures",
    "expiresAt",
    "credentialEnv",
    "assetsDir",
    "port",
  ];
  if (!raw || typeof raw !== "object" || Object.keys(raw).some((k) => !keys.includes(k)))
    throw new Error("Journal gateway configuration invalid");
  for (const key of ["allowedUserId", "paperSpaceId", "assetsDir"])
    if (typeof raw[key] !== "string" || !raw[key].trim())
      throw new Error("Journal gateway configuration invalid");
  if (
    !Array.isArray(raw.procedures) ||
    !raw.procedures.length ||
    raw.procedures.length > 64 ||
    raw.procedures.some(
      (p) => typeof p !== "string" || !/^trading\/[A-Za-z][A-Za-z0-9]*$/.test(p),
    ) ||
    new Set(raw.procedures).size !== raw.procedures.length
  )
    throw new Error("Journal gateway configuration invalid");
  if (
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(raw.credentialEnv ?? "") ||
    !/^rkg_[A-Za-z0-9_-]{43}$/.test(env[raw.credentialEnv] ?? "") ||
    !Number.isFinite(Date.parse(raw.expiresAt)) ||
    !path.isAbsolute(raw.assetsDir) ||
    !Number.isInteger(raw.port) ||
    raw.port < 1024 ||
    raw.port > 65535
  )
    throw new Error("Journal gateway configuration invalid");
  return {
    ...raw,
    publicOrigin: localOrigin(raw.publicOrigin),
    authOrigin: localOrigin(raw.authOrigin ?? raw.publicOrigin),
    authApi: localOrigin(raw.authApi),
    paperApi: localOrigin(raw.paperApi),
    paperOrigin: localOrigin(raw.paperOrigin),
    accessToken: env[raw.credentialEnv],
    assetsDir: path.resolve(raw.assetsDir),
  };
}

function reply(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function boundedBytes(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  if (!reader) return new Uint8Array();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function createJournalGateway(config, fetchImpl = fetch, now = Date.now) {
  async function authenticate(request) {
    const headers = new Headers({ origin: config.authOrigin ?? config.publicOrigin });
    for (const name of ["cookie", "authorization"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has("cookie") && !headers.has("authorization"))
      return reply(401, "Sign in to Rakazo");
    let response, data;
    try {
      response = await fetchImpl(`${config.authApi}/api/auth/get-session?disableCookieCache=true`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      });
      if (response.status >= 500) return reply(503, "Rakazo authentication unavailable");
      if (!response.ok) return reply(401, "Sign in to Rakazo");
      data = JSON.parse(Buffer.from(await boundedBytes(response, 65536)).toString("utf8"));
    } catch {
      return reply(503, "Rakazo authentication unavailable");
    }
    if (
      !data?.user?.id ||
      !data?.session?.expiresAt ||
      !Number.isFinite(Date.parse(data.session.expiresAt)) ||
      Date.parse(data.session.expiresAt) <= now()
    )
      return reply(401, "Sign in to Rakazo");
    if (
      data.user.id !== config.allowedUserId ||
      (data.session.userId && data.session.userId !== data.user.id)
    )
      return reply(403, "Journal access denied");
    return null;
  }

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (pathname.startsWith(`${PREFIX}/assets/`)) {
        if (request.method !== "GET" && request.method !== "HEAD")
          return reply(405, "Method not allowed");
        const relative = decodeURIComponent(pathname.slice(`${PREFIX}/`.length));
        if (
          !/^assets\/[A-Za-z0-9._/-]+$/.test(relative) ||
          relative.split("/").some((s) => s === ".." || s === ".")
        )
          return reply(404, "Not found");
        const base = await realpath(config.assetsDir);
        let file;
        try {
          file = await realpath(path.join(base, relative));
        } catch {
          return reply(404, "Not found");
        }
        const fromBase = path.relative(base, file);
        if (fromBase.startsWith("..") || path.isAbsolute(fromBase)) return reply(404, "Not found");
        const type = MIME[path.extname(file)];
        const info = await stat(file);
        if (!type || !info.isFile() || info.size > MAX_RESPONSE) return reply(404, "Not found");
        return new Response(request.method === "HEAD" ? null : await readFile(file), {
          headers: {
            "content-type": type,
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          },
        });
      }
      const isOffline = pathname === `${PREFIX}/offline-review`;
      const isStatus = pathname === `${PREFIX}/status`;
      const isView = pathname === `${PREFIX}/view`;
      const isRpc = pathname.startsWith(`${PREFIX}/rpc/`);
      if (!isStatus && !isOffline && !isView && !isRpc) return reply(404, "Not found");
      if (isRpc) {
        if (request.method !== "POST") return reply(405, "Method not allowed");
        if (request.headers.get("origin") !== config.publicOrigin)
          return reply(403, "Origin denied");
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
          return reply(415, "JSON required");
        if (url.search) return reply(404, "Not found");
        const procedure = pathname.slice(`${PREFIX}/rpc/`.length);
        if (!config.procedures.includes(procedure)) return reply(403, "Procedure not linked");
      } else if (request.method !== "GET") return reply(405, "Method not allowed");
      const denied = await authenticate(request);
      if (denied) return denied;
      if (now() >= Date.parse(config.expiresAt)) return reply(410, "Linked access expired");
      if (isStatus)
        return new Response(JSON.stringify({ available: true }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      if (isOffline) {
        if (url.search) return reply(404, "Not found");
        const marker = path.join(path.dirname(config.assetsDir), "paper-offline-lifecycle.json");
        let bytes;
        try {
          const info = await stat(marker);
          if (!info.isFile() || info.size > 4096) return reply(503, "Offline status unavailable");
          bytes = await readFile(marker, "utf8");
        } catch (error) {
          if (error?.code === "ENOENT")
            return new Response(JSON.stringify({ state: "no_record", reviewPending: false }), {
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            });
          return reply(503, "Offline status unavailable");
        }
        let data;
        try {
          data = JSON.parse(bytes);
        } catch {
          return reply(503, "Offline status unavailable");
        }
        const start = Date.parse(data?.stoppedAtUtc);
        const resumed =
          typeof data?.resumedAtUtc === "string" ? Date.parse(data.resumedAtUtc) : null;
        if (
          data?.mode !== "PAPER_ONLY" ||
          !Number.isFinite(start) ||
          (resumed !== null && (!Number.isFinite(resumed) || resumed < start)) ||
          !["stopping", "offline", "resumed_review_pending"].includes(data.state)
        )
          return reply(503, "Offline status unavailable");
        const result = {
          state: data.state,
          stoppedAtUtc: new Date(start).toISOString(),
          resumedAtUtc: resumed === null ? null : new Date(resumed).toISOString(),
          durationSeconds: Math.floor(((resumed ?? now()) - start) / 1000),
          reviewPending: true,
          stopTargetReview: "not_verified",
          fundingReview: "required",
          syntheticFills: false,
          mayAuthorizeEntries: false,
        };
        if (
          config.procedures.includes("trading/perpetualJournalList") &&
          config.procedures.includes("trading/perpetualWorkspaceRead")
        ) {
          try {
            const readRpc = async (procedure, input, limit = 65536) => {
              const upstream = await fetchImpl(config.paperApi + "/rpc/" + procedure, {
                method: "POST",
                headers: {
                  authorization: "Bearer " + config.accessToken,
                  origin: config.paperOrigin,
                  "x-rakazo-space-id": config.paperSpaceId,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ json: input }),
                redirect: "error",
                signal: AbortSignal.timeout(5000),
              });
              if (
                !upstream.ok ||
                !upstream.headers.get("content-type")?.includes("application/json")
              )
                throw new Error("PAPER account status unavailable");
              const payload = JSON.parse(
                Buffer.from(await boundedBytes(upstream, limit)).toString("utf8"),
              );
              return payload.json ?? payload;
            };
            const list = await readRpc("trading/perpetualJournalList", {});
            if (
              list?.mode !== "paper_only" ||
              !Array.isArray(list.ledgers) ||
              list.ledgers.length > 3
            )
              throw new Error("Invalid PAPER account list");
            const rows = await Promise.all(
              list.ledgers.map(async (entry) => {
                if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(entry?.ledgerId ?? ""))
                  throw new Error("Invalid ledger ID");
                const w = await readRpc("trading/perpetualWorkspaceRead", {
                  ledgerId: entry.ledgerId,
                });
                if (
                  w?.status !== "verified" ||
                  w.ledgerId !== entry.ledgerId ||
                  !["paused", "active"].includes(w.sessionStatus)
                )
                  throw new Error("Invalid PAPER workspace");
                return {
                  ledgerId: entry.ledgerId,
                  rawPlans: w.positionPlans,
                  summary: {
                    strategy: ["conservative", "moderate", "aggressive"].includes(w.strategy)
                      ? w.strategy
                      : "unknown",
                    sessionStatus: w.sessionStatus,
                    phase: ["protection_only", "attention_required", "running"].includes(w.phase)
                      ? w.phase
                      : "other",
                    pendingOrders: Array.isArray(w.openOrders) ? w.openOrders.length : null,
                    protectivePlans: Array.isArray(w.positionPlans) ? w.positionPlans.length : null,
                  },
                };
              }),
            );
            result.accounts = rows.map((row) => row.summary);
            if (
              resumed !== null &&
              config.procedures.includes("trading/catalog") &&
              config.procedures.includes("trading/perpetualJournalRead")
            ) {
              try {
                result.marketReviews = await inspectOfflinePositions({
                  rows,
                  readRpc,
                  fetchImpl,
                  now,
                  start,
                  resumed,
                });
              } catch {
                result.marketReviewStatus = "unavailable";
              }
            } else {
              result.marketReviewStatus = resumed === null ? "awaiting_restart" : "unavailable";
            }
          } catch {
            result.accountsStatus = "unavailable";
          }
        }
        return new Response(JSON.stringify(result), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (isView) {
        const html = await readFile(path.join(config.assetsDir, "index.html"));
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors " +
              config.publicOrigin,
          },
        });
      }
      const body = Buffer.from(await boundedBytes(new Response(request.body), MAX_BODY));
      const procedure = pathname.slice(`${PREFIX}/rpc/`.length);
      let upstream;
      try {
        upstream = await fetchImpl(`${config.paperApi}/rpc/${procedure}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            origin: config.paperOrigin,
            "x-rakazo-space-id": config.paperSpaceId,
            "content-type": "application/json",
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        });
        if (upstream.status >= 300 && upstream.status < 400)
          return reply(502, "Journal unavailable");
        if (!upstream.headers.get("content-type")?.toLowerCase().includes("application/json"))
          return reply(502, "Journal unavailable");
        const result = await boundedBytes(upstream, MAX_RESPONSE);
        if (Buffer.from(result).includes(Buffer.from(config.accessToken)))
          return reply(502, "Journal unavailable");
        return new Response(result, {
          status: upstream.status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return reply(502, "Journal unavailable");
      }
    } catch {
      return reply(503, "Journal unavailable");
    }
  };
}

export async function startJournalGateway(config, fetchImpl = fetch) {
  const handle = createJournalGateway(config, fetchImpl);
  const server = createServer(async (req, res) => {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.writeHead(413, { connection: "close" });
          res.end();
          return;
        }
        chunks.push(chunk);
      }
      const init = { method: req.method, headers: req.headers };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = Buffer.concat(chunks);
      const response = await handle(new Request(new URL(req.url, config.publicOrigin), init));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  return server;
}

export async function drainJournalGateway(server) {
  // Stop accepting sockets, allow authenticated reads to finish, and then exit.
  // Never destroy active requests or claim success on timeout.
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = validateConfig(JSON.parse(await readFile(process.argv[2], "utf8")));
    const server = await startJournalGateway(config);
    const stopDir = process.env.RAKAZO_PAPER_STOP_DIR?.trim();
    if (stopDir) {
      await createPaperStopControl({
        directory: stopDir,
        service: "gateway",
        drain: () => drainJournalGateway(server),
        exit: (code) => process.exit(code),
        onError: () => console.error("Journal gateway graceful shutdown failed"),
      });
    }
    console.log("journal gateway ready");
  } catch {
    console.error("Journal gateway could not start");
    process.exitCode = 1;
  }
}
