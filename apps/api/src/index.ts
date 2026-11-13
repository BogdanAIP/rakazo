import { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import { serve } from "@hono/node-server";
import { createPaperStopControl } from "@rakazo/adapters";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { drainPaperApiHttp } from "./paper-graceful-http.js";

const logger = createRootLogger(SERVICE_NAMES.api);

try {
  const env = loadEnv();
  const { app, stop } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });

  // Long-lived connections (threads.subscribe SSE streams) never end on their
  // own, so server.close() alone waits forever for them. Track sockets and
  // force-close any still open after a short grace period for in-flight
  // requests, or every restart/shutdown hangs until something force-kills it.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let stopTask: Promise<void> | undefined;
  const shutdown = (strict = false): Promise<void> => {
    // Hono's server type also admits HTTP/2. The controlled PAPER runtime
    // must prove it is HTTP/1 before claiming a fully drained request queue.
    if (!(server instanceof HttpServer)) {
      return Promise.reject(new Error("PAPER graceful shutdown requires HTTP/1"));
    }
    stopTask ??= drainPaperApiHttp({
      server,
      sockets,
      stop,
      flush: () => logger.flush({ timeoutMs: 2_000 }),
      strict,
    });
    return stopTask;
  };
  const paperStopDir = process.env.RAKAZO_PAPER_STOP_DIR?.trim();
  if (paperStopDir) {
    await createPaperStopControl({
      directory: paperStopDir,
      service: "api",
      drain: () => shutdown(true),
      exit: (code) => process.exit(code),
      onError: (error) => logger.error("PAPER API graceful shutdown failed", error),
    });
  }
  process.once(
    "SIGTERM",
    () => void shutdown().catch((error) => logger.error("API shutdown failed", error)),
  );
  process.once(
    "SIGINT",
    () => void shutdown().catch((error) => logger.error("API shutdown failed", error)),
  );
} catch (error) {
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
