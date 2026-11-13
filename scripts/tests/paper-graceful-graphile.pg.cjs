"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

async function main() {
  const pnpm = path.resolve(__dirname, "../../node_modules/.pnpm");
  const findOne = (pattern) => {
    const matches = fs.readdirSync(pnpm).filter((s) => pattern.test(s));
    if (matches.length !== 1) throw Error(`Expected one dependency: ${pattern}`);
    return path.join(pnpm, matches[0], "node_modules");
  };
  const gwRoot = findOne(/^graphile-worker@/);
  const pgRoot = findOne(/^pg@/);
  const { run, makeWorkerUtils } = require(path.join(gwRoot, "graphile-worker"));
  const { pathToFileURL } = require("node:url");
  const settlementFile = path.resolve(
    __dirname,
    "../../packages/adapters/src/graphile-settlement.ts",
  );
  const { awaitGraphileJobSettlements } = await import(pathToFileURL(settlementFile).href);
  const { Pool } = require(path.join(pgRoot, "pg"));
  // Never connect the integration smoke test to a live/user database.
  const cluster = process.argv[2];
  if (!cluster || !path.basename(cluster).startsWith("rakazo-pg-drain-qa-")) {
    throw Error("Disposable PostgreSQL cluster path must be explicitly provided");
  }
  const data = path.resolve(cluster, "data");
  const registry = fs.readFileSync(path.join(data, "postmaster.pid"), "utf8").split(/\r?\n/);
  if (
    registry[1].replaceAll("\\", "/").toLowerCase() !== data.replaceAll("\\", "/").toLowerCase() ||
    registry[3] !== "15549"
  ) {
    throw Error("Disposable PostgreSQL cluster identity and port mismatch");
  }
  const pool = new Pool({
    host: "127.0.0.1",
    port: 15549,
    user: "qa_worker",
    database: "postgres",
    max: 5,
    connectionTimeoutMillis: 2000,
  });
  let runner;
  let utils;
  let releaseJob;
  let startedJob;
  const started = new Promise((resolve) => {
    startedJob = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseJob = resolve;
  });
  let taskFinished = false;
  try {
    runner = await run({
      pgPool: pool,
      concurrency: 1,
      pollInterval: 100,
      noHandleSignals: true,
      taskList: {
        qa_pending: async () => {
          startedJob();
          await blocked;
          taskFinished = true;
        },
      },
    });
    utils = await makeWorkerUtils({ pgPool: pool });
    await utils.addJob("qa_pending", { test: "disposable" });
    await Promise.race([
      started,
      delay(8000).then(() => {
        throw Error("Disposable job never started");
      }),
    ]);
    let stopSettled = false;
    const stopTask = runner.stop().then(() => {
      stopSettled = true;
    });
    await delay(400);
    assert.equal(stopSettled, false, "Graphile STOP returned before job finished");
    assert.equal(taskFinished, false, "Job unexpectedly finished before gate");
    releaseJob();
    await Promise.race([
      stopTask,
      delay(8000).then(() => {
        throw Error("Graphile stop timed out");
      }),
    ]);
    assert.equal(taskFinished, true, "Graphile did not wait for pending job");
    await awaitGraphileJobSettlements(pool, { timeoutMs: 8000 });
    const { rows } = await pool.query(
      "select id from graphile_worker._private_jobs where locked_at is not null limit 1",
    );
    assert.equal(rows.length, 0, "Pending job acknowledgement not persisted");
    console.log("PASS: Graphile persisted job completion before pool shutdown");
    console.log("PASS: real disposable PostgreSQL/Graphile stop waits for pending task");
    console.log("PASS: stop does not report success until task finishes");
  } finally {
    releaseJob?.();
    await runner?.stop().catch(() => undefined);
    await utils?.release().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}
main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
