import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperStopControl } from "./paper-graceful-stop.js";

const folders: string[] = [];
const controls: Array<{ close: () => void }> = [];
async function tempDir() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "rakazo-worker-stop-"));
  folders.push(folder);
  return folder;
}
afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const ack = (folder: string) => path.join(folder, "paper-worker-stop.ack.json");
async function request(folder: string, ready: Record<string, unknown>, override = {}) {
  await writeFile(
    path.join(folder, "paper-worker-stop.request.json"),
    JSON.stringify({
      pid: ready.pid,
      instanceId: ready.instanceId,
      token: ready.token,
      requestId: "7e3b0d4c-1bf4-4c09-af0e-89b578daf283",
      ...override,
    }),
  );
}
async function setup(
  folder: string,
  drain: () => Promise<void>,
  exit = vi.fn(),
  onError = vi.fn(),
) {
  const control = await createPaperStopControl({
    directory: folder,
    pid: 46001,
    drain,
    exit,
    onError,
    pollMs: 10_000,
  });
  controls.push(control);
  const ready = JSON.parse(
    await readFile(path.join(folder, "paper-worker-stop.ready.json"), "utf8"),
  );
  return { control, ready, exit, onError };
}
describe("PAPER-only graceful worker stop handshake", () => {
  it("writes an unpredictable per-instance token and never stops without a request", async () => {
    const dir = await tempDir();
    const drain = vi.fn().mockResolvedValue(undefined);
    const { control, ready } = await setup(dir, drain);
    expect(ready).toMatchObject({ mode: "PAPER_ONLY", pid: 46001, version: 1 });
    expect(ready.token).toMatch(/^[a-f0-9]{64}$/);
    await control.check();
    expect(drain).not.toHaveBeenCalled();
  });
  it("rejects stale token, foreign PID and wrong worker instance", async () => {
    const dir = await tempDir();
    const drain = vi.fn().mockResolvedValue(undefined);
    const { control, ready } = await setup(dir, drain);
    await request(dir, ready, { token: "0".repeat(64) });
    await control.check();
    await request(dir, ready, { pid: 1234 });
    await control.check();
    await request(dir, ready, { instanceId: "old" });
    await control.check();
    expect(drain).not.toHaveBeenCalled();
  });
  it("acknowledges drain only after pending job completion", async () => {
    const dir = await tempDir();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const drain = vi.fn().mockReturnValue(pending);
    const exit = vi.fn();
    const { control, ready } = await setup(dir, drain, exit);
    await request(dir, ready);
    const stopping = control.check();

    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    await expect(readFile(ack(dir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(exit).not.toHaveBeenCalled();
    complete();
    await stopping;
    const receipt = JSON.parse(await readFile(ack(dir), "utf8"));
    expect(receipt).toMatchObject({
      mode: "PAPER_ONLY",
      state: "drained",
      pid: 46001,
      instanceId: ready.instanceId,
      requestId: "7e3b0d4c-1bf4-4c09-af0e-89b578daf283",
    });
    expect(receipt).not.toHaveProperty("token");
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("does not terminate a worker when the drain fails", async () => {
    const dir = await tempDir();
    const exit = vi.fn();
    const onError = vi.fn();
    const { control, ready } = await setup(
      dir,
      async () => {
        throw new Error("pending job failed to finish");
      },
      exit,
      onError,
    );
    await request(dir, ready);
    await control.check();
    const receipt = JSON.parse(await readFile(ack(dir), "utf8"));
    expect(receipt.state).toBe("failed");
    expect(exit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
  it("never drains twice for the same request", async () => {
    const dir = await tempDir();
    const drain = vi.fn().mockResolvedValue(undefined);
    const { control, ready } = await setup(dir, drain);
    await request(dir, ready);
    await control.check();
    await control.check();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
  });
  it("does not interpret malformed requests as shutdown approval", async () => {
    const dir = await tempDir();
    const drain = vi.fn().mockResolvedValue(undefined);
    const { control } = await setup(dir, drain);
    await writeFile(path.join(dir, "paper-worker-stop.request.json"), "not-json");
    await control.check();
    expect(drain).not.toHaveBeenCalled();
  });
  it("isolates API, gateway and worker control files in the same runtime", async () => {
    const dir = await tempDir();
    const exit = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const api = await createPaperStopControl({
      directory: dir, service: "api", pid: 46002,
      drain: close, exit, pollMs: 10_000,
    });
    controls.push(api);
    const control = JSON.parse(await readFile(path.join(dir, "paper-api-stop.ready.json"), "utf8"));
    expect(control.service).toBe("api");
    await writeFile(path.join(dir, "paper-worker-stop.request.json"), JSON.stringify({
      pid: control.pid, instanceId: control.instanceId, token: control.token,
      requestId: "7e3b0d4c-1bf4-4c09-af0e-89b578daf283",
    }));
    await api.check();
    expect(close).not.toHaveBeenCalled();
    await writeFile(path.join(dir, "paper-api-stop.request.json"), JSON.stringify({
      pid: control.pid, instanceId: control.instanceId, token: control.token,
      requestId: "7e3b0d4c-1bf4-4c09-af0e-89b578daf283",
    }));
    await api.check();
    expect(close).toHaveBeenCalledTimes(1);
    const ack = JSON.parse(await readFile(path.join(dir, "paper-api-stop.ack.json"), "utf8"));
    expect(ack).toMatchObject({ state: "drained", service: "api", pid: 46002 });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
