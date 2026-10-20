// ../../../../../../rakazo-paper-graceful-worker-20261020/packages/adapters/src/paper-graceful-stop.ts
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

async function atomicJson(file, data) {
  const temp = file.concat(".", randomUUID(), ".tmp");
  try {
    await writeFile(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx", mode: 384 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => void 0);
  }
}
async function createPaperStopControl(options) {
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
    readyAtUtc: /* @__PURE__ */ new Date().toISOString(),
  });
  let occupied = false;
  let closing = false;
  let accepted = false;
  async function check() {
    if (occupied || closing || accepted) return;
    occupied = true;
    try {
      let bytes;
      try {
        bytes = await readFile(request, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (Buffer.byteLength(bytes) > 1024) return;
      let data;
      try {
        data = JSON.parse(bytes);
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
          finishedAtUtc: /* @__PURE__ */ new Date().toISOString(),
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

export { createPaperStopControl };
