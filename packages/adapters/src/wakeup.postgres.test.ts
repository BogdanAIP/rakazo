import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { createPool } from "@rakazo/db";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

let pool: Pool | undefined;
function testPool(): Pool {
  pool ??= new Pool({ connectionString: databaseUrl, max: 4 });
  return pool;
}
afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

function handlers(overrides: Partial<BackgroundJobHandlers> = {}): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "paper.worker-preflight": vi.fn(async () => undefined),
    "paper.protection-check": vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

describePostgres("Graphile background jobs (PostgreSQL contract)", () => {
  it("waits for an active handler during graceful shutdown", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const entered = deferred();
    const release = deferred();
    let completed = false;
    const target = handlers({
      "run.continue": async () => {
        entered.resolve();
        await release.promise;
        completed = true;
      },
    });

    try {
      await host.start(target);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "graceful-stop" } });
      await entered.promise;

      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);

      release.resolve();
      await stopping;
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("replaces a keyed delayed job without running the old payload or schedule", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    const target = handlers({
      "computer.sleep": async ({ computerId }) => {
        received.push(computerId);
      },
    });
    const key = `contract:replacement:${Date.now()}`;

    try {
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "old" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      const replacementAt = new Date(Date.now() + 800);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "replacement" },
        availableAt: replacementAt,
        replaceKey: key,
      });
      const scheduled = await testPool().query(
        "select run_at from graphile_worker.jobs where key = $1",
        [key],
      );
      expect(scheduled.rows).toEqual([{ run_at: replacementAt }]);
      await host.start(target);
      await waitFor(() => expect(received).toEqual(["replacement"]));
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("removes a keyed delayed job before a worker can run it", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const target = handlers();
    const key = `contract:cancellation:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "cancelled" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.cancel(key);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  it("persists a handler failure and retries the job successfully", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    let attempts = 0;
    const target = handlers({
      "run.continue": async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("intentional contract-test failure");
      },
    });
    const key = `contract:retry:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "retry" },
        replaceKey: key,
      });
      await waitFor(() => expect(attempts).toBe(2), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts).toBe(2);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it.each([
    { name: "complete_job", failHandler: false, committed: false },
    { name: "fail_job", failHandler: true, committed: true },
  ])("retries a lost $name receipt without rerunning that handler attempt", async (fixture) => {
    const runnerPool = createPool(databaseUrl!);
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(runnerPool, { concurrency: 1, pollInterval: 25 });
    const key = `contract:settlement:${fixture.name}`;
    let settlements = 0;
    let executions = 0;
    runnerPool.on("connect", (client) => {
      const query = client.query;
      client.query = ((...args: unknown[]) => {
        const statement = args[0] as { name?: string } | undefined;
        if (statement?.name !== `${fixture.name}/graphile_worker` || ++settlements !== 1)
          return Reflect.apply(query, client, args);
        const lost = Object.assign(new Error("Fixture lost PostgreSQL settlement receipt"), {
          code: "ECONNRESET",
        });
        // A lost receipt can follow either a rollback or a commit.
        return fixture.committed
          ? Promise.resolve(Reflect.apply(query, client, args)).then(() => {
              throw lost;
            })
          : Promise.reject(lost);
      }) as typeof client.query;
    });
    const target = handlers({
      "run.continue": async () => {
        executions++;
        if (fixture.failHandler && executions === 1) throw new Error("Fixture handler retry");
      },
    });

    try {
      await host.start(target);
      await publisher.enqueue({ name: "run.continue", payload: { runId: key }, replaceKey: key });
      await vi.waitFor(
        async () => {
          const result = await testPool().query(
            "select id from graphile_worker._private_jobs where key = $1",
            [key],
          );
          expect(result.rowCount).toBe(0);
          expect(settlements).toBe(2);
          expect(executions).toBe(fixture.failHandler ? 2 : 1);
        },
        { timeout: 15_000, interval: 50 },
      );
      await host.stop();
    } finally {
      try {
        await host.stop();
      } finally {
        await publisher.cancel(key).catch(() => undefined);
        await publisher.close();
        await runnerPool.end();
      }
    }
  });
});
