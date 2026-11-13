import type { Server } from "node:http";
import type { Socket } from "node:net";

/**
 * Strict PAPER shutdown never destroys active HTTP requests.
 * On a stuck request the owner controller times out, but cannot claim drained.
 * Non-strict signal handling preserves Rakazo API's existing short SSE grace.
 */
export async function drainPaperApiHttp(options: {
  server: Server;
  sockets: Set<Socket>;
  stop: () => Promise<void>;
  flush: () => Promise<void>;
  strict: boolean;
}): Promise<void> {
  const { server, sockets, stop, flush, strict } = options;
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeIdleConnections();
  const grace = strict
    ? undefined
    : setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 2_000);
  try {
    await closed;
    await stop();
    await flush();
  } finally {
    if (grace) clearTimeout(grace);
  }
}
