import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  enqueuePaperWorkerPreflightOnce,
  type PaperWorkerOneShotScheduleResult,
} from "./paper-worker-scheduler.js";

type Owner = { spaceId: string; userId: string };
type Schedule = typeof enqueuePaperWorkerPreflightOnce;

function parseStartArgs(value: unknown): { ledgerId: string; expectedGateRevision: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid paper worker start payload");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["expected_gate_revision", "ledger_id"])) {
    throw new Error("Unexpected paper worker start fields");
  }
  const ledgerId = row.ledger_id;
  const revision = row.expected_gate_revision;
  if (
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new Error("Invalid paper worker start payload");
  }
  return { ledgerId, expectedGateRevision: revision as number };
}

/** Explicit-approval caller for exactly one D3 read-only preflight enqueue.
 * This helper cannot configure cadence or recurrence and owns no trading writer. */
export async function startPaperWorkerPreflightOnce(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  owner: Owner,
  args: unknown,
  schedule: Schedule = enqueuePaperWorkerPreflightOnce,
): Promise<PaperWorkerOneShotScheduleResult> {
  const request = parseStartArgs(args);
  return schedule(deps, {
    spaceId: owner.spaceId,
    userId: owner.userId,
    ledgerId: request.ledgerId,
    expectedGateRevision: request.expectedGateRevision,
  });
}
