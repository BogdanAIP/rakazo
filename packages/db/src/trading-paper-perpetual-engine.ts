import type {
  PaperPerpetualEngineBatch,
  PaperPerpetualEngineConfig,
  PaperPerpetualEngineSnapshot,
} from "@rakazo/contracts";
import {
  PaperPerpetualEngineBatchSchema,
  PaperPerpetualEngineConfigSchema,
  PaperPerpetualEngineSnapshotSchema,
} from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import type { PerpetualOwner } from "./trading-paper-perpetual-workspace.js";
import {
  perpetualPaperHash as hash,
  perpetualPaperJson as json,
} from "./trading-paper-perpetual-workspace.js";

type Transition = {
  input: PaperPerpetualEngineBatch;
  output: PaperPerpetualEngineSnapshot;
  recordedAt: Date;
};
type Recovered = {
  config: PaperPerpetualEngineConfig;
  headSha256: string;
  snapshot: PaperPerpetualEngineSnapshot | null;
  transitions: Transition[];
  effectiveConfig: PaperPerpetualEngineConfig;
};
/** A transaction-scoped verified journal. Never reuse across transactions:
 * the first read verifies the entire chain; further reads compare the locked
 * row head and projection before using the verified result.
 */
const verifiedWithinTransaction = new WeakMap<
  Prisma.TransactionClient,
  Map<string, { owner: PerpetualOwner; result: Recovered }>
>();
function cacheTransactionRecovery(
  tx: Prisma.TransactionClient,
  owner: PerpetualOwner,
  ledgerId: string,
  recovered: Recovered,
): void {
  let entries = verifiedWithinTransaction.get(tx);
  if (!entries) {
    entries = new Map();
    verifiedWithinTransaction.set(tx, entries);
  }
  entries.set(ledgerId, { owner: { ...owner }, result: recovered });
}

const genesis = (owner: PerpetualOwner, config: PaperPerpetualEngineConfig) =>
  hash(["paper_engine_journal_v1", { spaceId: owner.spaceId, userId: owner.userId }, config]);
const link = (previous: string, input: unknown, output: unknown) =>
  hash([previous, hash(input), hash(output)]);
const money = (value: string): bigint => {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const n = BigInt(whole!) * 100000000n + BigInt(fraction.padEnd(8, "0"));
  return negative ? -n : n;
};

function register(
  config: PaperPerpetualEngineConfig,
  updates: PaperPerpetualEngineBatch["registerInstruments"],
): PaperPerpetualEngineConfig {
  const terms = new Map(config.instruments.map((i) => [i.instrument, i]));
  const changed = new Set<string>();
  for (const term of updates ?? []) {
    if (changed.has(term.instrument)) throw new Error("Duplicate PAPER contract update");
    changed.add(term.instrument);
    // Same-market registration is a versioned refresh. It is safe only while
    // flat; Nautilus enforces the flat-account invariant during native apply.
    terms.set(term.instrument, term);
  }
  if (terms.size > 256) throw new Error("PAPER contract registry full");
  return { ...config, instruments: [...terms.values()] };
}

function validate(
  config: PaperPerpetualEngineConfig,
  input: PaperPerpetualEngineBatch,
  output: PaperPerpetualEngineSnapshot,
  prior: PaperPerpetualEngineSnapshot | null,
) {
  if (
    config.accountId !== output.accountId ||
    config.engineId !== output.engineId ||
    config.engineVersion !== output.engineVersion ||
    input.sequence !== output.sequence ||
    output.sequence !== (prior?.sequence ?? 0) + 1 ||
    output.leverage !== (input.leverage ?? prior?.leverage ?? config.leverage) ||
    BigInt(output.clockNs) < BigInt(prior?.clockNs ?? "0") ||
    input.quotes.some((q) => BigInt(q.atNs) > BigInt(output.clockNs)) ||
    output.eventCount !== (prior?.eventCount ?? 0) + output.events.length ||
    money(output.balanceQuote) !== money(output.availableQuote) + money(output.lockedQuote) ||
    money(output.balanceQuote) !== 100000000000n + money(output.realizedPnlQuote) ||
    new Set(output.positions.map((p) => p.positionId)).size !== output.positions.length ||
    output.positions.some((p) => !config.instruments.some((i) => i.instrument === p.instrument))
  )
    throw new Error("PAPER engine projection invariant failed");
}
/** Caller must already hold the owner workspace/ledger lock. No RPC, permissions,
 * matcher or second wallet. This verifies persisted native input/result history.
 */
export async function recoverPerpetualEngineInTransaction(
  tx: Prisma.TransactionClient,
  owner: PerpetualOwner,
  ledgerId: string,
): Promise<Recovered | null> {
  const member = await tx.spaceMember.findFirst({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true },
  });
  if (!member) throw new Error("Owner PAPER engine unavailable");
  const ledger = await tx.tradingPaperPerpetualLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
  });
  if (!ledger) throw new Error("Owner PAPER engine unavailable");
  const row = await tx.tradingPaperPerpetualEngine.findUnique({ where: { ledgerId } });
  if (!row) return null;
  const config = PaperPerpetualEngineConfigSchema.parse(row.config);
  if (
    config.accountId !== ledgerId ||
    hash(config) !== row.configSha256 ||
    ledger.version !== 0 ||
    ledger.initialBalanceQuote !== "1000" ||
    ledger.quoteCurrency !== "USDT"
  )
    throw new Error("PAPER engine configuration integrity failed");
  const verified = verifiedWithinTransaction.get(tx)?.get(ledgerId);
  if (
    verified?.owner.spaceId === owner.spaceId &&
    verified.owner.userId === owner.userId &&
    verified.result.headSha256 === row.headSha256 &&
    verified.result.snapshot?.sequence === row.sequence &&
    (verified.result.snapshot === null
      ? row.projection === null && row.projectionSha256 === null
      : hash(verified.result.snapshot) === row.projectionSha256 &&
        hash(row.projection) === row.projectionSha256)
  ) {
    return verified.result;
  }
  const batches = await tx.tradingPaperPerpetualEngineBatch.findMany({
    where: { ledgerId },
    orderBy: { sequence: "asc" },
  });
  if (batches.length !== row.sequence || batches.length > 200000)
    throw new Error("PAPER engine journal gap");
  let previous = genesis(owner, config),
    snapshot: PaperPerpetualEngineSnapshot | null = null;
  const transitions: Transition[] = [];
  let effectiveConfig = config;
  for (const record of batches) {
    const input = PaperPerpetualEngineBatchSchema.parse(record.input);
    const output = PaperPerpetualEngineSnapshotSchema.parse(record.output);
    effectiveConfig = register(effectiveConfig, input.registerInstruments);
    validate(effectiveConfig, input, output, snapshot);
    const chain = link(previous, input, output);
    if (
      record.sequence !== transitions.length + 1 ||
      record.sequence !== input.sequence ||
      record.inputSha256 !== hash(input) ||
      record.outputSha256 !== hash(output) ||
      record.previousSha256 !== previous ||
      record.chainSha256 !== chain
    )
      throw new Error("PAPER engine journal integrity failed");
    transitions.push({ input, output, recordedAt: record.recordedAt });
    snapshot = output;
    previous = chain;
  }
  if (
    previous !== row.headSha256 ||
    (snapshot === null
      ? row.projection !== null || row.projectionSha256 !== null
      : hash(snapshot) !== row.projectionSha256 || hash(row.projection) !== hash(snapshot))
  )
    throw new Error("PAPER engine projection differs from journal");
  const result = { config, headSha256: previous, snapshot, transitions, effectiveConfig };
  cacheTransactionRecovery(tx, owner, ledgerId, result);
  return result;
}
/** Internal composition-only append AFTER independent risk/revision/session checks.
 * The adapter must discard its process after a failed enclosing transaction and
 * replay only committed rows. Existing custom ledger money cannot coexist.
 */
export async function appendPerpetualEngineBatchInTransaction(
  tx: Prisma.TransactionClient,
  owner: PerpetualOwner,
  raw: {
    config: PaperPerpetualEngineConfig;
    batchId: string;
    input: PaperPerpetualEngineBatch;
    output: PaperPerpetualEngineSnapshot;
    expectedHead: string | null;
  },
) {
  const config = PaperPerpetualEngineConfigSchema.parse(raw.config);
  const input = PaperPerpetualEngineBatchSchema.parse(raw.input);
  const output = PaperPerpetualEngineSnapshotSchema.parse(raw.output);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.batchId))
    throw new Error("Invalid PAPER batch identity");
  const member = await tx.spaceMember.findFirst({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true },
  });
  if (!member) throw new Error("PAPER engine membership denied");
  await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "trading_paper_perpetual_ledgers"
  WHERE id=${config.accountId} AND "spaceId"=${owner.spaceId} AND "ownerUserId"=${owner.userId} FOR UPDATE`;
  const recovered = await recoverPerpetualEngineInTransaction(tx, owner, config.accountId);
  const previous = recovered?.headSha256 ?? genesis(owner, config);
  if (recovered && hash(recovered.config) !== hash(config))
    throw new Error("PAPER engine configuration changed");
  const duplicate = await tx.tradingPaperPerpetualEngineBatch.findUnique({
    where: { ledgerId_batchId: { ledgerId: config.accountId, batchId: raw.batchId } },
  });
  if (duplicate) {
    if (duplicate.inputSha256 !== hash(input) || duplicate.outputSha256 !== hash(output))
      throw new Error("Conflicting PAPER engine retry");
    return { status: "duplicate" as const, headSha256: duplicate.chainSha256 };
  }
  if (raw.expectedHead !== (recovered?.headSha256 ?? null))
    throw new Error("PAPER engine head changed");
  validate(
    register(recovered?.effectiveConfig ?? config, input.registerInstruments),
    input,
    output,
    recovered?.snapshot ?? null,
  );
  if (!recovered) {
    const ledger = await tx.tradingPaperPerpetualLedger.findUniqueOrThrow({
      where: { id: config.accountId },
    });
    if (ledger.version !== 0) throw new Error("Existing custom wallet cannot change executor");
    await tx.tradingPaperPerpetualEngine.create({
      data: {
        ledgerId: config.accountId,
        config: json(config),
        configSha256: hash(config),
        headSha256: previous,
      },
    });
  }
  const chain = link(previous, input, output);
  const appended = await tx.tradingPaperPerpetualEngineBatch.create({
    data: {
      ledgerId: config.accountId,
      sequence: input.sequence,
      batchId: raw.batchId,
      input: json(input),
      output: json(output),
      inputSha256: hash(input),
      outputSha256: hash(output),
      previousSha256: previous,
      chainSha256: chain,
    },
  });
  const changed = await tx.tradingPaperPerpetualEngine.updateMany({
    where: { ledgerId: config.accountId, sequence: input.sequence - 1, headSha256: previous },
    data: {
      sequence: input.sequence,
      headSha256: chain,
      projection: json(output),
      projectionSha256: hash(output),
    },
  });
  if (changed.count !== 1) throw new Error("PAPER engine commit conflict");
  if (recovered) {
    const nextConfig = register(recovered.effectiveConfig, input.registerInstruments);
    cacheTransactionRecovery(tx, owner, config.accountId, {
      ...recovered,
      headSha256: chain,
      snapshot: output,
      effectiveConfig: nextConfig,
      transitions: [
        ...recovered.transitions,
        { input, output, recordedAt: appended.recordedAt },
      ],
    });
  }
  await tx.tradingPaperPerpetualLedger.update({
    where: { id: config.accountId },
    data: { updatedAt: new Date() },
  });
  return { status: "appended" as const, headSha256: chain };
}
