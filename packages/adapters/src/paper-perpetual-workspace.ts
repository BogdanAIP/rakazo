import type {
  AgentRunModel,
  AgentRuntime,
  BackgroundJobPayloads,
  JobPublisher,
  PaperPerpetualEngine,
} from "@rakazo/adapter-kit";
import { paperWorkerPreflightJob } from "@rakazo/adapter-kit";
import type {
  PaperPerpetualCommand,
  PaperPerpetualDecision,
  PaperPerpetualSnapshot,
} from "@rakazo/contracts";
import { PaperPerpetualDecisionSchema } from "@rakazo/contracts";
import {
  getPaperExperimentPreset,
  isFreshPaperObservation,
  PAPER_OKX_LV1_FEES,
  summarizePaperVolatilityContext,
} from "@rakazo/core";
import type { PerpetualOwner, PrismaClient } from "@rakazo/db";
import {
  cancelPerpetualEngineOrders,
  commandOwnedPerpetualWorkspace,
  commitPerpetualEngineWake,
  commitPerpetualPaperWake,
  completeIdleExternalPerpetualWake,
  failPerpetualWake,
  pausePerpetualAfterRestart,
  perpetualMarketSource,
  preparePerpetualEngineBeforeMarketFetch,
  readOwnedMarketPreparedResearch,
  readPerpetualWake,
  recordPerpetualResearchTick,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { invokePaperSkillDecision } from "./paper-skill-decision.js";
import { fetchOkxPaperPerpetualSnapshot } from "./trading-okx-perp.js";

type Deps = {
  engine?: PaperPerpetualEngine;
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue">;
  fetchSnapshot?: (instrument: string) => Promise<PaperPerpetualSnapshot>;
};
type WorkerDeps = Deps & {
  runtime: AgentRuntime;
  resolveModel: (scope: PerpetualOwner & { botId?: string }) => Promise<AgentRunModel>;
  fetchSnapshot?: (instrument: string) => Promise<PaperPerpetualSnapshot>;
};
async function enqueueNext(
  deps: Deps,
  owner: PerpetualOwner,
  ledgerId: string,
  expectedRevision?: number,
) {
  const row = await deps.prisma.tradingPaperPerpetualWorkspace.findFirst({
    where: { ledgerId, ledger: { spaceId: owner.spaceId, ownerUserId: owner.userId } },
  });
  if (
    !row?.nextScheduledFor ||
    (expectedRevision !== undefined && row.revision !== expectedRevision)
  )
    return;
  await deps.jobs.enqueue(
    paperWorkerPreflightJob({
      ...owner,
      ledgerId,
      gateRevision: row.revision,
      sessionRevision: row.revision,
      marketKind: "perpetual",
      scheduledFor: row.nextScheduledFor,
    }),
  );
}

/** Only a human command may grant an entry session. Queue failure pauses it. */
export async function controlPerpetualPaperWorkspace(
  deps: Deps,
  owner: PerpetualOwner,
  command: PaperPerpetualCommand,
) {
  if (
    (command.action === "start" ||
      command.action === "resume" ||
      command.action === "submit_external_proposal") &&
    !deps.engine &&
    process.env.NODE_ENV !== "test"
  )
    throw new Error("PAPER futures engine not configured");
  const limits =
    command.action === "set_leverage"
      ? await Promise.all(
          command.instruments.map(async (instrument) => {
            const snapshot = await (deps.fetchSnapshot ?? fetchOkxPaperPerpetualSnapshot)(
              instrument,
            );
            if (!snapshot.leverageLimits) throw new Error("Venue leverage limits unavailable");
            return snapshot.leverageLimits;
          }),
        )
      : [];
  const receipt = await commandOwnedPerpetualWorkspace(deps.prisma, owner, command, limits);
  try {
    if (deps.engine)
      await cancelPerpetualEngineOrders(
        deps.prisma,
        owner,
        command.ledgerId,
        deps.engine,
        receipt.revision,
      );
    await enqueueNext(deps, owner, command.ledgerId, receipt.revision);
  } catch (error) {
    await failPerpetualWake(
      deps.prisma,
      owner,
      command.ledgerId,
      receipt.revision,
      "queue_unavailable",
    );
    throw error;
  }
}

/** Reuses the existing PAPER queue and provider-neutral model runtime. Protection
 * commits before model work, so model failure cannot undo a protective fill. */
export async function handlePerpetualPaperWake(
  deps: WorkerDeps,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
) {
  if (payload.marketKind !== "perpetual" || payload.sessionRevision === undefined) return;
  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const key = {
    ledgerId: payload.ledgerId,
    revision: payload.sessionRevision,
    scheduledFor: payload.scheduledFor,
  };
  let failure = "market_data_unavailable";
  try {
    const first = await readPerpetualWake(
      deps.prisma,
      owner,
      key.ledgerId,
      key.revision,
      key.scheduledFor,
    );
    if (!first) return;
    if (
      first.control.researchMode === "external" &&
      (await completeIdleExternalPerpetualWake(deps.prisma, owner, key))
    ) {
      await enqueueNext(deps, owner, key.ledgerId, key.revision);
      return;
    }
    if (deps.engine)
      await preparePerpetualEngineBeforeMarketFetch(deps.prisma, owner, key.ledgerId, deps.engine);
    const fetchSnapshot = deps.fetchSnapshot ?? fetchOkxPaperPerpetualSnapshot;
    const read = async (symbols: string[]) =>
      Promise.all([...new Set(symbols)].map((symbol) => fetchSnapshot(symbol)));
    // An unavailable selected-but-unused market must not prevent protection
    // of live positions or pending orders in other instruments.
    const activeProtectionSymbols = [
      ...first.state.openPositions.map((p) => p.instrument),
      ...(deps.engine ? first.control.orders.map((o) => o.proposal.instrument) : []),
    ];
    // Flat-account bootstrap still registers selected markets. With exposure,
    // only instruments needing protection can block the protective stage.
    const protection = await read(
      activeProtectionSymbols.length ? activeProtectionSymbols : first.control.instruments,
    );
    const commit = (
      stage: {
        ledgerId: string;
        revision: number;
        scheduledFor: string;
        stage: "protection" | "research";
      },
      observations: PaperPerpetualSnapshot[],
    ) =>
      deps.engine
        ? commitPerpetualEngineWake(deps.prisma, owner, stage, observations, deps.engine)
        : process.env.NODE_ENV === "test"
          ? commitPerpetualPaperWake(deps.prisma, owner, stage, observations)
          : Promise.reject(new Error("PAPER futures engine not configured"));
    const protectionKey = { ...key, stage: "protection" as const };
    await recordPerpetualResearchTick(deps.prisma, owner, protectionKey, protection, {
      kind: "no_trade",
      reason: "Protect existing positions before research",
    });
    failure = "protection_unavailable";
    await commit(protectionKey, protection);

    const current = await readPerpetualWake(
      deps.prisma,
      owner,
      key.ledgerId,
      key.revision,
      key.scheduledFor,
    );
    if (!current) return;
    const researchKey = { ...key, stage: "research" as const };
    let decision: PaperPerpetualDecision = {
      kind: "no_trade",
      reason: "Waiting for the next five-minute analysis",
    };
    let snapshots: PaperPerpetualSnapshot[] = [];
    let model: AgentRunModel | undefined;
    const priorTick = await deps.prisma.tradingPaperPerpetualTick.findUnique({
      where: {
        ledgerId_revision_scheduledFor_stage: {
          ...researchKey,
          scheduledFor: new Date(key.scheduledFor),
        },
      },
    });
    if (priorTick) decision = PaperPerpetualDecisionSchema.parse(priorTick.decision);
    const due =
      !current.control.lastResearchAt ||
      current.now.getTime() - Date.parse(current.control.lastResearchAt) >= 300000;
    const fromExternal = current.control.researchMode === "external";
    const submitted = current.control.pendingExternalProposal;
    const hasExternalProposal =
      submitted &&
      Date.parse(submitted.submittedAt) <= current.now.getTime() &&
      Date.parse(submitted.expiresAt) > current.now.getTime();
    if (
      current.entries &&
      !current.control.orders.length &&
      due &&
      !priorTick &&
      (!fromExternal || hasExternalProposal)
    ) {
      failure = "market_skill_unavailable";
      if (!current.control.source) throw new Error("No selected futures skill");
      const prepared = await readOwnedMarketPreparedResearch(deps.prisma, owner, {
        semanticKey: "futures.data",
        resolverKey: current.control.source.resolverKey,
        expectedDigest: current.control.source.resolverDigest,
        limit: 50,
      });
      perpetualMarketSource(prepared);
      failure = "market_data_unavailable";
      snapshots = await read(current.control.instruments);
      if (
        snapshots.some(
          (s) =>
            !s.history.length ||
            current.now.getTime() -
              (Date.parse(s.history.at(-1)!.openedAt) + s.history.at(-1)!.durationMs) >
              7200000,
        )
      ) {
        throw new Error("Closed market history is stale");
      }
      if (fromExternal) {
        // No model call, no background prompt and no entry without an explicit
        // authenticated owner submission for this still-approved PAPER session.
        decision =
          submitted &&
          Date.parse(submitted.expiresAt) > current.now.getTime() &&
          Date.parse(submitted.submittedAt) <= current.now.getTime()
            ? submitted.decision
            : { kind: "no_trade", reason: "Нет действующего предложения ChatGPT через R" };
      } else {
        failure = "model_unavailable";
        // Each PAPER account owns its dedicated bot, so resolve that bot's model
        // selection instead of silently falling back to the space-wide default.
        model = await deps.resolveModel({ ...owner, botId: current.row.botId });
        const preset = getPaperExperimentPreset(current.state.strategy);
        const executionFees = current.control.instruments.map((instrument) => {
          const fees =
            current.engineConfig?.instruments.find((terms) => terms.instrument === instrument) ??
            (deps.engine ? PAPER_OKX_LV1_FEES : { makerFeeRate: "0.001", takerFeeRate: "0.001" });
          return { instrument, makerFeeRate: fees.makerFeeRate, takerFeeRate: fees.takerFeeRate };
        });
        const result = await invokePaperSkillDecision(deps.runtime, {
          owner,
          model,
          botId: current.row.botId,
          threadId: current.row.threadId,
          runId:
            "paper-futures-research:" + key.ledgerId + ":" + key.revision + ":" + key.scheduledFor,
          instructions: [
            "You research a virtual PAPER futures account. Return exactly one JSON decision matching the supplied schema.",
            "Use the selected Market Skill and supplied public OKX data. Never request exchange keys, real orders, account tools or delegation.",
            "Select an independent strategy suitable for this profile. Compare all allowed instruments and decide no_trade, a new proposal, a partial reduce-only exit, or close an existing position.",
            "Long and short positions are independent hedge lots. Opposite positions never cancel automatically. quantityBase is BASE currency, not contract count. You may hedge via a new opposite-side proposal if gross risk and remaining position slots allow it; a full close can free a slot for a later hedge.",
            "For reduce, specify an existing positionId and a positive quantityBase no greater than the held quantity, aligned to the contract lot increment; protect remaining lots. This never opens a new position. Opposite-side same-instrument hedges are independent ideas, but same-instrument same-side scale-ins share ONE per-idea loss budget across all lots.",
            "Use a stop and a profitable take-profit. Respect leverage, per-idea loss, daily loss, total open stop risk and position count caps. Futures have NO legacy fixed USDT gross-exposure cap; a trusted equity-based portfolio stress guard checks the full gross exposure.",
            "A volatile wick can stop out a good thesis; use the advisory ATR/wick context and public candles to assess stop distance. The diagnostic is a descriptive sample, not a trading signal, not a liquidation guarantee and not authority to delete or widen an existing protective exit.",
            "Plan recovery BEFORE the FIRST new position: propose plannedRecoveryNotionalQuote in USDT as your total optional future add capacity for that idea, or accept the independent automatic minimum of 50% of the initial position notional. This capacity is booked in the portfolio gross-stress, margin and stop-risk limits and cannot be spent on unrelated positions. Do NOT send automatic averaging orders. Explain why the reserve is enough or choose no_trade if the combined plan is unsafe.",
            "For a fresh new PAPER position, supply recoverySteps of EXACTLY two objects: {stepId,triggerPriceQuote,allocationPercent}. Allocation percentages must be positive integers totaling 100, with distinct IDs, ordered toward the protective HARD stop; for Long: stop < second trigger < first trigger < entry, and for Short: entry < first trigger < second trigger < stop. The fixed hard stop must be FURTHER away than the deepest planned averaging level. If such a plan would exhaust risk/capital, propose no_trade or a smaller initial position; never widen an existing stop to fit.",
            "A recoverySteps plan books OPTIONAL positions; it never places standing averaging orders. The live verified quote must visit a particular trigger AFTER the initial position is open; then a new confirmed two-pivot/neckline reversal plus whole-account stress authorization is mandatory. For an addition specify recoveryStepId from the persisted protectionPlans. Do not invent triggered stages or override original limits.",
            "To scale into an existing position, use proposal.addToPositionId with a real matching position id, instrument, side, current leverage and EXACT existing stop/take-profit; each additional fill consumes the same whole-idea stop-loss risk. If the existing position is underwater, a new scale-in must pass the independent 20+ confirmed-candle two-pivot and neckline-break structure gate, PLUS a fresh whole-account risk check; a new lower low alone never licenses a fill. The technical pattern is not a guarantee.",
            "For addToPositionId, the requested add must fit the remaining pre-booked recovery reserve shown under protectionPlans, in addition to every fresh risk and chart confirmation. A bigger recovery reserve requires a separately auditable plan revision; you cannot silently use another idea's booked capacity.",
            "To free a slot for a hedge or rotate an inferior position, use proposal.replacePositionId (NOT with addToPositionId). This requests closing that position first and entering the new proposal ONLY if the old position is fully closed and fresh independent risk checks still pass. A partial unfilled exit means no new entry. Never assume a replacement succeeded.",
            "If verified market movement permits a strictly safer protective stop, choose tighten_stop with positionId and stopPriceQuote. For long the new stop must be HIGHER than the old one but still BELOW the current mark; for short LOWER than the old one but still ABOVE the current mark. Stops are never widened or removed, and an existing risk budget is not credited just because the stop moved.",
            "Average daily return targets for a 14-day evaluation are research benchmarks, not per-session quotas. Long holds, short holds and no_trade are permitted; never trade to meet a target.",
            "Stop loss must budget entry and exit at the highest nonnegative supplied maker/taker rate for that instrument and include the adverse slippage reserve. Fee rates are decimal fractions of filled notional, not margin; marketable limits can be taker. Round quantity DOWN to lotIncrementBase.",
            "This simulator uses account-wide margin. Reserve gross initial margin for BOTH hedge legs plus fees. While any position is open, use its existing leverage for all new entries; owner maxLeverage is a ceiling. Maintenance and funding consume equity.",
            "Only choose a position when the public evidence supports it. Otherwise explain no_trade. Never invent prices or balance fields.",
            "Respond in Russian in rationale/reason. Your proposal is independently checked and may be denied by execution rules.",
          ].join("\n"),
          skill: { provenance: prepared.provenance, content: prepared.skillContent },
          data: {
            snapshots,
            volatilityContext: snapshots.map((row) => ({
              instrument: row.market.symbol,
              summary: summarizePaperVolatilityContext(row.history),
            })),
            preset: {
              id: preset.id,
              initialBalanceQuote: preset.initialBalanceQuote,
              maxPerIdeaRiskQuote: preset.maxPerIdeaRiskQuote,
              maxDailyLossQuote: preset.maxDailyLossQuote,
              maxOpenRiskQuote: preset.maxOpenRiskQuote,
              maxLeverage: current.control.maxLeverage ?? preset.maxLeverage,
              maxConcurrentPositions: preset.maxConcurrentPositions,
              positionMode: preset.positionMode,
              researchMode: preset.researchMode,
            },
            researchTargetAverageDailyReturnPercent:
              preset.id === "conservative" ? 1 : preset.id === "moderate" ? 2 : 3,
            futuresStressPolicy: {
              adverseMarketMovePercent:
                preset.id === "conservative" ? 35 : preset.id === "moderate" ? 25 : 20,
              minimumEquityRemainingAfterStressPercent: 25,
              minimumGrossMaintenanceReservePercent: 2,
              grossHedgeLegsCountSeparately: true,
              noStaticNotionalCap: true,
              longPriceCollapseScenarioPercent: 100,
              shortPriceRallyScenarioPercent: 200,
              survivalReservePercent: 25,
              liquidationImpossible: false,
            },
            account: current.state,
            protectionPlans: current.control.plans,
            allowedInstruments: current.control.instruments,
            executionFees,
            slippageReserveBpsPerSide: 10,
          },
          schema: z.toJSONSchema(PaperPerpetualDecisionSchema),
        });
        decision = PaperPerpetualDecisionSchema.parse(result);
      }
      if (
        !deps.engine &&
        (decision.kind === "reduce" ||
          decision.kind === "tighten_stop" ||
          (decision.kind === "proposal" &&
            (decision.addToPositionId || decision.replacePositionId)))
      ) {
        decision = {
          kind: "no_trade",
          reason:
            "Изменение существующей позиции доступно только через проверенный Nautilus PAPER.",
        };
      }
    }
    failure = "research_commit_unavailable";
    const recorded = await recordPerpetualResearchTick(
      deps.prisma,
      owner,
      researchKey,
      snapshots,
      decision,
      current.control.researchMode === "external" &&
        current.control.pendingExternalProposal &&
        Date.parse(current.control.pendingExternalProposal.expiresAt) > current.now.getTime()
        ? { provider: "external-proposal", modelId: "external-unattested" }
        : model
          ? { provider: model.provider, modelId: model.id }
          : undefined,
    );
    if (!recorded) return;
    decision = PaperPerpetualDecisionSchema.parse(recorded.decision);
    // A new or pending intent still needs a post-submission executable book.
    // No-trade native wakes can reuse the already-committed protection evidence.
    failure = "market_data_unavailable";
    const executionNow = new Date().toISOString();
    // The protection stage has already consumed the executable depth of
    // its public book observation. A no-trade research stage may carry marks
    // forward, but MUST NOT present the same liquidity a second time.
    const reuseProtection =
      deps.engine &&
      decision.kind === "no_trade" &&
      current.control.orders.length === 0 &&
      protection.every((s) =>
        [s.book.observedAt, s.markObservedAt, s.fetchedAt].every((at) =>
          isFreshPaperObservation(at, executionNow),
        ),
      );
    const execution = reuseProtection
      ? protection.map((snapshot) => ({
          ...snapshot,
          book: { ...snapshot.book, bidAvailableBase: "0", askAvailableBase: "0" },
        }))
      : await read([
          ...(deps.engine && decision.kind === "proposal" ? current.control.instruments : []),
          ...current.state.openPositions.map((p) => p.instrument),
          ...current.control.orders.map((o) => o.proposal.instrument),
          ...(decision.kind === "proposal" ? [decision.instrument] : []),
        ]);
    failure = "execution_unavailable";
    await commit(researchKey, execution);
    failure = "queue_unavailable";
    await enqueueNext(deps, owner, key.ledgerId, key.revision);
  } catch (error) {
    getLogger().error("paper perpetual wake failed", error, { "paper.failure": failure });
    if (deps.engine)
      await cancelPerpetualEngineOrders(deps.prisma, owner, key.ledgerId, deps.engine).catch(
        () => undefined,
      );
    await failPerpetualWake(deps.prisma, owner, key.ledgerId, key.revision, failure);
    await enqueueNext(deps, owner, key.ledgerId, key.revision);
  }
}

export async function reconcilePerpetualPaperWorkspaces(deps: Deps, restarting = false) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await deps.prisma.tradingPaperPerpetualWorkspace.findMany({
      take: 100,
      ...(cursor ? { where: { ledgerId: { gt: cursor } } } : {}),
      orderBy: { ledgerId: "asc" },
      include: { ledger: { select: { spaceId: true, ownerUserId: true } } },
    });
    for (const row of rows) {
      if (!row.ledger) continue;
      const owner = { spaceId: row.ledger.spaceId, userId: row.ledger.ownerUserId };
      try {
        if (restarting) {
          await pausePerpetualAfterRestart(deps.prisma, owner, row.ledgerId);
          if (deps.engine)
            await cancelPerpetualEngineOrders(deps.prisma, owner, row.ledgerId, deps.engine);
        }
        await enqueueNext(deps, owner, row.ledgerId);
      } catch {
        /* A corrupt/unavailable workspace cannot grant new authority. Retry the next reconciliation pass. */
      }
    }
    if (rows.length < 100) return;
    cursor = rows.at(-1)!.ledgerId;
  }
}
