import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Windows cannot deliver a POSIX graceful SIGTERM to arbitrary Node processes.
 * PAPER-only, opt-in, one-shot local file handshake for draining existing jobs.
 * It never writes to the trading journal or signals an unrelated process.
 */
export type PaperStopControl = Readonly<{
  pid: number;
  instanceId: string;
  token: string;
  close: () => void;
  check: () => Promise<void>;
}>;

type StopRequest = {
  pid: number;
  instanceId: string;
  token: string;
  requestId: string;
};

async function atomicJson(file: string, data: object): Promise<void> {
  const temp = file.concat(".", randomUUID(), ".tmp");
  try {
    await writeFile(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function createPaperStopControl(options: {
  directory: string;
  service?: "worker" | "api" | "gateway";
  pid?: number;
  drain: () => Promise<void>;
  exit: (code: number) => void;
  pollMs?: number;
  onError?: (error: unknown) => void;
}): Promise<PaperStopControl> {
  const directory = path.resolve(options.directory);
  if (!path.isAbsolute(options.directory) || !Number.isInteger(options.pid ?? process.pid))
    throw new Error("PAPER shutdown control requires an absolute directory and valid PID");
  const pid = options.pid ?? process.pid;
  const service = options.service ?? "worker";
  if (!["worker", "api", "gateway"].includes(service))
    throw new Error("Unsupported PAPER service shutdown scope");
  const instanceId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const ready = path.join(directory, "paper-" + service + "-stop.ready.json");
  const request = path.join(directory, "paper-" + service + "-stop.request.json");
  const ack = path.join(directory, "paper-" + service + "-stop.ack.json");

  await atomicJson(ready, {
    version: 1,
    mode: "PAPER_ONLY",
    service,
    pid,
    instanceId,
    token,
    readyAtUtc: new Date().toISOString(),
  });

  let occupied = false;
  let closing = false;
  let accepted = false;
  async function check(): Promise<void> {
    if (occupied || closing || accepted) return;
    occupied = true;
    try {
      let bytes: string;
      try {
        bytes = await readFile(request, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (Buffer.byteLength(bytes) > 1024) return;
      let data: Partial<StopRequest>;
      try {
        data = JSON.parse(bytes) as Partial<StopRequest>;
      } catch {
        return;
      }
      if (
        data.pid !== pid ||
        data.instanceId !== instanceId ||
        data.token !== token ||
        !/^[0-9a-f-]{36}$/i.test(data.requestId ?? "")
      )
        return;
      accepted = true;
      closing = true;
      clearInterval(timer);
      try {
        await options.drain();
        await atomicJson(ack, {
          version: 1,
          mode: "PAPER_ONLY",
          service,
          pid,
          instanceId,
          requestId: data.requestId,
          state: "drained",
          finishedAtUtc: new Date().toISOString(),
        });
        options.exit(0);
      } catch (error) {
        await atomicJson(ack, {
          version: 1,
          mode: "PAPER_ONLY",
          service,
          pid,
          instanceId,
          requestId: data.requestId,
          state: "failed",
        }).catch(options.onError);
        options.onError?.(error);
        // Deliberately do not force an exit or claim a successful drain.
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      occupied = false;
    }
  }
  const timer = setInterval(() => void check(), options.pollMs ?? 250);
  timer.unref();
  return {
    pid,
    instanceId,
    token,
    check,
    close: () => {
      closing = true;
      clearInterval(timer);
    },
  };
}
