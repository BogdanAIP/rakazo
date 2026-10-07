import { createHash } from "node:crypto";
import {
  type TradingInstrument,
  type TradingResearchOutput,
  TradingResearchOutputSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export class PaperWorkerResearchIntegrityError extends Error {
  constructor(message = "Synthetic paper worker research integrity mismatch") {
    super(message);
    this.name = "PaperWorkerResearchIntegrityError";
  }
}

export type PaperWorkerResearchRecord = {
  status: "recorded" | "duplicate";
  ledgerId: string;
  sourceScheduledFor: string;
  gateRevision: number;
  targetRevision: number;
  quoteEvidenceId: string;
  algorithm: string;
  signalId: string;
  signalKind: "proposal" | "no_trade";
};

type ResearchWrite = {
  sourceScheduledFor: string;
  gateRevision: number;
  targetRevision: number;
  quoteEvidenceId: string;
  output: unknown;
};

function sameMarket(left: TradingInstrument, right: TradingInstrument): boolean {
  return (
    left.venue === right.venue &&
    left.kind === right.kind &&
    left.symbol === right.symbol &&
    left.base === right.base &&
    left.quote === right.quote &&
    left.status === right.status &&
    left.priceIncrement === right.priceIncrement &&
    left.quantityIncrement === right.quantityIncrement &&
    left.minNotional === right.minNotional &&
    left.expiryAt === right.expiryAt
  );
}

function digest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  sourceScheduledFor: string;
  gateRevision: number;
  targetRevision: number;
  quoteEvidenceId: string;
  output: TradingResearchOutput;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.sourceScheduledFor,
        value.gateRevision,
        value.targetRevision,
        value.quoteEvidenceId,
        value.output,
      ]),
      "utf8",
    )
    .digest("hex");
}

function parseInput(input: ResearchWrite): {
  sourceScheduledFor: Date;
  sourceScheduledForIso: string;
  gateRevision: number;
  targetRevision: number;
  quoteEvidenceId: string;
  output: TradingResearchOutput;
} {
  const scheduled = new Date(input.sourceScheduledFor);
  if (
    !Number.isFinite(scheduled.getTime()) ||
    !Number.isSafeInteger(input.gateRevision) ||
    input.gateRevision < 0 ||
    !Number.isSafeInteger(input.targetRevision) ||
    input.targetRevision < 1 ||
    !/^paper-worker:[a-f0-9]{64}$/u.test(input.quoteEvidenceId)
  ) {
    throw new PaperWorkerResearchIntegrityError("Invalid paper worker research scope");
  }
  return {
    sourceScheduledFor: scheduled,
    sourceScheduledForIso: scheduled.toISOString(),
    gateRevision: input.gateRevision,
    targetRevision: input.targetRevision,
    quoteEvidenceId: input.quoteEvidenceId,
    output: TradingResearchOutputSchema.parse(input.output),
  };
}

function rowOutput(value: Prisma.JsonValue): TradingResearchOutput {
  const parsed = TradingResearchOutputSchema.safeParse(value);
  if (!parsed.success) throw new PaperWorkerResearchIntegrityError("Stored research output invalid");
  return parsed.data;
}

export async function recordTradingPaperWorkerResearchOutput(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  input: ResearchWrite,
): Promise<PaperWorkerResearchRecord> {
  const parsed = parseInput(input);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperWorkerResearchRecord> => {
        const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
          tx,
          owner,
          ledgerId,
          parsed.quoteEvidenceId,
        );
        if (!evidence) {
          throw new PaperWorkerResearchIntegrityError("Worker quote evidence unavailable");
        }
        if (evidence.market.venue !== "okx" || !sameMarket(evidence.market, parsed.output.market)) {
          throw new PaperWorkerResearchIntegrityError(
            "Research market differs from verified quote evidence",
          );
        }

        const expected = {
          ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          sourceScheduledFor: parsed.sourceScheduledForIso,
          gateRevision: parsed.gateRevision,
          targetRevision: parsed.targetRevision,
          quoteEvidenceId: parsed.quoteEvidenceId,
          output: parsed.output,
        };
        const outputSha256 = digest(expected);
        const key = {
          ledgerId_sourceScheduledFor_gateRevision_targetRevision: {
            ledgerId,
            sourceScheduledFor: parsed.sourceScheduledFor,
            gateRevision: parsed.gateRevision,
            targetRevision: parsed.targetRevision,
          },
        };
        const existing = await tx.tradingPaperWorkerResearch.findUnique({ where: key });
        if (existing) {
          const stored = rowOutput(existing.output);
          if (
            existing.spaceId !== owner.spaceId ||
            existing.userId !== owner.userId ||
            existing.quoteEvidenceId !== parsed.quoteEvidenceId ||
            existing.algorithm !== stored.algorithm ||
            existing.signalId !== stored.signal.signalId ||
            existing.signalKind !== stored.signal.kind ||
            existing.outputSha256 !==
              digest({
                ledgerId: existing.ledgerId,
                spaceId: existing.spaceId,
                userId: existing.userId,
                sourceScheduledFor: existing.sourceScheduledFor.toISOString(),
                gateRevision: existing.gateRevision,
                targetRevision: existing.targetRevision,
                quoteEvidenceId: existing.quoteEvidenceId,
                output: stored,
              }) ||
            existing.outputSha256 !== outputSha256
          ) {
            throw new PaperWorkerResearchIntegrityError("Conflicting paper worker research replay");
          }
          return {
            status: "duplicate",
            ledgerId,
            sourceScheduledFor: parsed.sourceScheduledForIso,
            gateRevision: parsed.gateRevision,
            targetRevision: parsed.targetRevision,
            quoteEvidenceId: parsed.quoteEvidenceId,
            algorithm: stored.algorithm,
            signalId: stored.signal.signalId,
            signalKind: stored.signal.kind,
          };
        }

        await tx.tradingPaperWorkerResearch.create({
          data: {
            ledgerId,
            spaceId: owner.spaceId,
            userId: owner.userId,
            sourceScheduledFor: parsed.sourceScheduledFor,
            gateRevision: parsed.gateRevision,
            targetRevision: parsed.targetRevision,
            quoteEvidenceId: parsed.quoteEvidenceId,
            algorithm: parsed.output.algorithm,
            signalId: parsed.output.signal.signalId,
            signalKind: parsed.output.signal.kind,
            output: JSON.parse(JSON.stringify(parsed.output)) as Prisma.InputJsonValue,
            outputSha256,
          },
        });
        return {
          status: "recorded",
          ledgerId,
          sourceScheduledFor: parsed.sourceScheduledForIso,
          gateRevision: parsed.gateRevision,
          targetRevision: parsed.targetRevision,
          quoteEvidenceId: parsed.quoteEvidenceId,
          algorithm: parsed.output.algorithm,
          signalId: parsed.output.signal.signalId,
          signalKind: parsed.output.signal.kind,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function readVerifiedTradingPaperWorkerResearchOutput(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  input: Omit<ResearchWrite, "output" | "quoteEvidenceId">,
): Promise<{ record: PaperWorkerResearchRecord; output: TradingResearchOutput }> {
  const scheduled = new Date(input.sourceScheduledFor);
  if (
    !Number.isFinite(scheduled.getTime()) ||
    !Number.isSafeInteger(input.gateRevision) ||
    input.gateRevision < 0 ||
    !Number.isSafeInteger(input.targetRevision) ||
    input.targetRevision < 1
  ) {
    throw new PaperWorkerResearchIntegrityError("Invalid paper worker research lookup");
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const row = await tx.tradingPaperWorkerResearch.findUnique({
          where: {
            ledgerId_sourceScheduledFor_gateRevision_targetRevision: {
              ledgerId,
              sourceScheduledFor: scheduled,
              gateRevision: input.gateRevision,
              targetRevision: input.targetRevision,
            },
          },
        });
        if (!row || row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerResearchIntegrityError("Paper worker research unavailable");
        }
        const output = rowOutput(row.output);
        const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
          tx,
          owner,
          ledgerId,
          row.quoteEvidenceId,
        );
        if (
          !evidence ||
          evidence.market.venue !== "okx" ||
          !sameMarket(evidence.market, output.market) ||
          row.algorithm !== output.algorithm ||
          row.signalId !== output.signal.signalId ||
          row.signalKind !== output.signal.kind ||
          row.outputSha256 !==
            digest({
              ledgerId,
              spaceId: row.spaceId,
              userId: row.userId,
              sourceScheduledFor: row.sourceScheduledFor.toISOString(),
              gateRevision: row.gateRevision,
              targetRevision: row.targetRevision,
              quoteEvidenceId: row.quoteEvidenceId,
              output,
            })
        ) {
          throw new PaperWorkerResearchIntegrityError();
        }
        return {
          record: {
            status: "duplicate" as const,
            ledgerId,
            sourceScheduledFor: row.sourceScheduledFor.toISOString(),
            gateRevision: row.gateRevision,
            targetRevision: row.targetRevision,
            quoteEvidenceId: row.quoteEvidenceId,
            algorithm: row.algorithm,
            signalId: row.signalId,
            signalKind: row.signalKind as "proposal" | "no_trade",
          },
          output,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
