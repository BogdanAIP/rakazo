import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPaperStopControl } from "./paper-graceful-stop-runtime.mjs";
import { drainJournalGateway } from "./server.mjs";

test("gateway waits for an in-flight HTTP request before confirming closed", async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const server = createServer(async (_, response) => {
    entered();
    await blocked;
    response.end("verified");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const reply = fetch("http://127.0.0.1:" + port + "/test");
    await started;
    let settled = false;
    const closed = drainJournalGateway(server).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, "Gateway falsely reported all requests completed");
    release();
    assert.equal(await (await reply).text(), "verified");
    await closed;
    assert.equal(settled, true);
  } finally {
    release?.();
    if (server.listening) await drainJournalGateway(server);
  }
});

test("shared gateway shutdown proof uses separate identity and never affects worker", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "paper-service-graceful-"));
  const result = [];
  try {
    const gateway = await createPaperStopControl({
      directory: folder,
      service: "gateway",
      drain: async () => result.push("gateway drained"),
      exit: (code) => result.push(code),
      pollMs: 60000,
    });
    const ready = JSON.parse(
      await readFile(path.join(folder, "paper-gateway-stop.ready.json"), "utf8"),
    );
    assert.equal(ready.service, "gateway");
    const request = {
      pid: ready.pid,
      instanceId: ready.instanceId,
      token: ready.token,
      requestId: "7e3b0d4c-1bf4-4c09-af0e-89b578daf283",
    };
    await writeFile(path.join(folder, "paper-worker-stop.request.json"), JSON.stringify(request));
    await gateway.check();
    assert.deepEqual(result, []);
    await writeFile(path.join(folder, "paper-gateway-stop.request.json"), JSON.stringify(request));
    await gateway.check();
    assert.deepEqual(result, ["gateway drained", 0]);
    const ack = JSON.parse(
      await readFile(path.join(folder, "paper-gateway-stop.ack.json"), "utf8"),
    );
    assert.equal(ack.state, "drained");
    assert.equal(ack.service, "gateway");
    gateway.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
