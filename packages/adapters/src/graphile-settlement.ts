import type { Pool } from "pg";

/**
 * Graphile 0.17 calls completeJob() asynchronously after a task handler returns.
 * runner.stop() can resolve while the completion write still owns a job lock.
 * Never disconnect the shared PostgreSQL pool until those writes have settled.
 *
 * This intentionally checks every locked job in the dedicated PAPER queue:
 * another owner or a stale lock means shutdown cannot be proven safe.
 */
export async function awaitGraphileJobSettlements(
  pgPool: Pick<Pool, "query">,
  options: { timeoutMs?: number; pause?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pause =
    options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await pgPool.query(
      "select id from graphile_worker._private_jobs where locked_at is not null limit 1",
    );
    if (result.rows.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error("Graphile job completion remains uncommitted; keep PAPER PostgreSQL online");
    }
    await pause(100);
  }
}
