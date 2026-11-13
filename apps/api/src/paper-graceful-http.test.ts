import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { drainPaperApiHttp } from "./paper-graceful-http.js";

describe("PAPER API strict HTTP drain", () => {
  it("waits for an unfinished HTTP request", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = createServer(async (_, res) => {
      entered();
      await waiting;
      res.end("committed");
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const flush = vi.fn().mockResolvedValue(undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("QA bind missing");
      const response = fetch("http://127.0.0.1:" + address.port + "/qa");
      await started;
      let closed = false;
      const drain = drainPaperApiHttp({
        server,
        sockets: new Set(),
        stop,
        flush,
        strict: true,
      }).then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(closed).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      release();
      expect(await (await response).text()).toBe("committed");
      await drain;
      expect(stop).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
    }
  });
  it("refuses cleanup when HTTP server close fails", async () => {
    const stop = vi.fn();
    const server = {
      close: (cb: (err: Error) => void) => cb(Error("close failed")),
      closeIdleConnections: () => undefined,
    };
    await expect(
      drainPaperApiHttp({
        server: server as never,
        sockets: new Set(),
        strict: true,
        stop,
        flush: vi.fn(),
      }),
    ).rejects.toThrow("close failed");
    expect(stop).not.toHaveBeenCalled();
  });
});
