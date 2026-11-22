import { randomUUID } from "node:crypto";
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
  PerpetualControl,
  TradingScanOutput,
} from "@rakazo/contracts";
import { PaperPerpetualDecisionSchema } from "@rakazo/contracts";
import {
  getPaperExperimentPreset,
  isFreshPaperObservation,
  PAPER_OKX_LV1_FEES,
  PAPER_PERPETUAL_RISK_POLICY_VERSION,
  suggestPaperPerpetualCryptoUniverse,
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
  reschedulePerpetualProtectionAfterResearchExpiry,
  retryTransientPerpetualMarketWake,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { generateNativePaperDecision } from "./paper-native-auto-research.js";
import { invokePaperSkillDecision } from "./paper-skill-decision.js";
import { fetchOkxPaperPerpetualSnapshot } from "./trading-okx-perp.js";
import { fetchOkxPaperPerpetualResearchScan } from "./trading-paper-perpetual-discovery.js";

type Deps = {
  engine?: PaperPerpetualEngine;
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue">;
  fetchSnapshot?: typeof fetchOkxPaperPerpetualSnapshot;
};
type WorkerDeps = Deps & {
  runtime: AgentRuntime;
  resolveModel: (scope: PerpetualOwner & { botId?: string }) => Promise<AgentRunModel>;
  fetchResearchScan?: () => Promise<Pick<TradingScanOutput, "fetchedAt" | "candidates">>;
  nativeResearch?: typeof generateNativePaperDecision;
  fetchSnapshot?: typeof fetchOkxPaperPerpetualSnapshot;
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
  if (receipt.duplicate) {
    await enqueueNext(deps, owner, command.ledgerId, receipt.revision);
    return;
  }
  try {
    if (
      deps.engine &&
      command.action !== "extend" &&
      command.action !== "set_instruments" &&
      command.action !== "set_auto_research"
    )
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
export function continuousPaperRenewalDue(
  control: Pick<
    PerpetualControl,
    | "autoExtend"
    | "sessionStatus"
    | "researchMode"
    | "source"
    | "expiresAt"
    | "closeAll"
    | "runtimeError"
  >,
  now: Date,
): boolean {
  const end = control.expiresAt ? Date.parse(control.expiresAt) : Number.NaN;
  return (
    control.autoExtend === true &&
    control.sessionStatus === "active" &&
    control.researchMode === "external" &&
    control.source !== null &&
    control.closeAll === false &&
    control.runtimeError === null &&
    Number.isFinite(end) &&
    end > now.getTime() &&
    end - now.getTime() <= 24 * 60 * 60 * 1000
  );
}

/** Uses the existing owner-approved worker queue, not an external scheduler. */
async function renewContinuousPaperIfDue(
  deps: WorkerDeps,
  owner: PerpetualOwner,
  key: { ledgerId: string; revision: number; scheduledFor: string },
  control: PerpetualControl,
  now: Date,
): Promise<boolean> {
  if (!continuousPaperRenewalDue(control, now)) return false;
  await controlPerpetualPaperWorkspace(deps, owner, {
    action: "extend",
    ledgerId: key.ledgerId,
    commandId: randomUUID(),
    expectedRevision: key.revision,
    durationMinutes: 20160,
  });
  return true;
}

/** Only transport failures are retryable; invalid risk, stale observations,
 * native engine faults, and malformed public venue data remain fail-closed. */
export function isTransientPaperMarketNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    ((error instanceof TypeError || error.name === "TypeError") &&
      /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i.test(error.message))
  );
}
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
  let failure = "database_unavailable";
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
      first.state.openPositions.length === 0 &&
      (await renewContinuousPaperIfDue(deps, owner, key, first.control, first.now))
    )
      return;
    if (
      first.control.researchMode === "external" &&
      !first.control.autoResearch &&
      (await completeIdleExternalPerpetualWake(deps.prisma, owner, key))
    ) {
      await enqueueNext(deps, owner, key.ledgerId, key.revision);
      return;
    }
    if (deps.engine)
      await preparePerpetualEngineBeforeMarketFetch(deps.prisma, owner, key.ledgerId, deps.engine);
    const fetchSnapshot = deps.fetchSnapshot ?? fetchOkxPaperPerpetualSnapshot;
    const read = async (symbols: string[], history?: "omit") =>
      Promise.all(
        [...new Set(symbols)].map((symbol) =>
          history ? fetchSnapshot(symbol, { history }) : fetchSnapshot(symbol),
        ),
      );
    // An unavailable selected-but-unused market must not prevent protection
    // of live positions or pending orders in other instruments.
    const activeProtectionSymbols = [
      ...first.state.openPositions.map((p) => p.instrument),
      ...(deps.engine ? first.control.orders.map((o) => o.proposal.instrument) : []),
    ];
    // Flat-account bootstrap still registers selected markets. With exposure,
    // only instruments needing protection can block the protective stage.
    const externalRequestedSymbol =
      first.control.researchMode === "external" &&
      first.control.pendingExternalProposal?.decision.kind === "proposal"
        ? first.control.pendingExternalProposal.decision.instrument
        : null;
    // Protect held lots; capture only the proposed market when flat.
    failure = "market_data_unavailable";
    const protection = await read(
      activeProtectionSymbols.length
        ? activeProtectionSymbols
        : first.control.researchMode === "external"
          ? externalRequestedSymbol
            ? [externalRequestedSymbol]
            : []
          : first.control.instruments.slice(0, 8),
      // Research outages must not block an existing hard stop or funding update.
      // Native entries are canceled before protective quotes; later entry captures still need history.
      first.state.openPositions.length > 0 ? "omit" : undefined,
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
    failure = "database_unavailable";
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
    if (
      current.state.openPositions.length > 0 &&
      (await renewContinuousPaperIfDue(deps, owner, key, current.control, current.now))
    )
      return;
    const researchKey = { ...key, stage: "research" as const };
    let decision: PaperPerpetualDecision = {
      kind: "no_trade",
      reason: "Waiting for the next five-minute analysis",
    };
    let snapshots: PaperPerpetualSnapshot[] = [];
    let model: AgentRunModel | undefined;
    let nativeResearchExecuted = false;
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
      current.now.getTime() - Date.parse(current.control.lastResearchAt) >=
        (current.control.autoResearch ? 900000 : 300000);
    const fromExternal = current.control.researchMode === "external";
    const submitted = current.control.pendingExternalProposal;
    const hasExternalProposal =
      submitted &&
      Date.parse(submitted.submittedAt) <= current.now.getTime() &&
      Date.parse(submitted.expiresAt) > current.now.getTime();
    const nativeAuto =
      fromExternal && current.control.autoResearch === true && !hasExternalProposal;
    if (
      current.entries &&
      !current.control.orders.length &&
      due &&
      !priorTick &&
      (!fromExternal || hasExternalProposal || nativeAuto)
    ) {
      if (nativeAuto) {
        failure = "native_research_unavailable";
        const recentProposals = await deps.prisma.tradingPaperPerpetualTick.findMany({
          where: {
            ledgerId: key.ledgerId,
            stage: "research",
            recordedAt: { gte: new Date(current.now.getTime() - 86_400_000) },
          },
          select: { decision: true },
        });
        const generated = await (deps.nativeResearch ?? generateNativePaperDecision)({
          profile: current.state.strategy,
          approved: current.control.instruments,
          availableQuote: current.state.availableQuote,
          equityQuote: current.state.markedEquityQuote,
          openPositionCount: current.state.openPositions.length,
          heldInstruments: current.state.openPositions.map((position) => position.instrument),
          proposalsLast24h: recentProposals.filter(
            (tick) => (tick.decision as { kind?: string } | null)?.kind === "proposal",
          ).length,
          fetchSnapshot: (symbol) => fetchSnapshot(symbol),
        });
        decision = generated.decision;
        snapshots = generated.snapshots;
        nativeResearchExecuted = true;
      } else {
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
        const affectedPosition =
          submitted && "positionId" in submitted.decision ? submitted.decision.positionId : null;
        snapshots = await read(
          fromExternal
            ? submitted?.decision.kind === "proposal"
              ? [
                  submitted.decision.instrument,
                  ...current.state.openPositions.map((p) => p.instrument),
                ]
              : current.state.openPositions
                  .filter((position) => position.positionId === affectedPosition)
                  .map((position) => position.instrument)
            : current.control.instruments.slice(0, 8),
        );
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
          failure = "market_data_unavailable";
          const discovery = await (deps.fetchResearchScan ?? fetchOkxPaperPerpetualResearchScan)();
          const universe = suggestPaperPerpetualCryptoUniverse(discovery, preset.id);
          if (universe.stale) throw new Error("Stale PAPER research discovery");
          const candidatesBySymbol = new Map(
            discovery.candidates.map((row) => [row.market.symbol, row]),
          );
          const rankedCandidates = universe.researchSymbols.map((symbol) => ({
            ...candidatesBySymbol.get(symbol)!,
            executionAuthorized: current.control.instruments.includes(symbol),
          }));
          failure = "model_unavailable";
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
              "paper-futures-research:" +
              key.ledgerId +
              ":" +
              key.revision +
              ":" +
              key.scheduledFor,
            instructions: [
              "You research a virtual PAPER futures account. Return exactly one JSON decision matching the supplied schema.",
              "Use the selected Market Skill and supplied public OKX data. Never request exchange keys, real orders, account tools or delegation.",
              "Use distinct, auditable experimental entry methods: conservative prioritizes H4/H1 trend pullbacks, moderate prioritizes structural breakout/retest and confirmed range reversal, aggressive prioritizes volatility compression/expansion and independently verified liquidity/flow signals. Profile does not bypass quality or risk gates. Review every ranked candidate in researchUniverse before comparing the detailed snapshots of the owner-approved allowedInstruments. The research universe has no eight-symbol cap. Markets with executionAuthorized=false are research/watch candidates only: mention a better outside-session candidate in reason/rationale, but never propose an entry outside allowedInstruments or include it in the executable comparison. Decide no_trade, a new allowed proposal, a partial reduce-only exit, or close an existing position.",
              "Include comparison with asOf, validUntil (at most 30 minutes after asOf), method, profileRationale, and candidates: {instrument, verdict: selected|rejected|watch, reason, facts:[{name,value}]}. For a proposal select exactly its instrument; for no_trade or management select none. Use the supplied capture times and real public facts. Include futuresStressPolicy.policyVersion in comparison.method. Explain suitability for this risk profile beyond its leverage ceiling.",
              "Long and short positions are independent hedge lots. Opposite positions never cancel automatically. quantityBase is BASE currency, not contract count. You may hedge via a new opposite-side proposal if gross risk and remaining position slots allow it; a full close can free a slot for a later hedge.",
              "For reduce, specify an existing positionId and a positive quantityBase no greater than the held quantity, aligned to the contract lot increment; protect remaining lots. This never opens a new position. Opposite-side same-instrument hedges are independent ideas, but same-instrument same-side scale-ins share ONE per-idea loss budget across all lots.",
              "OWNER-RULE v4: Fixed 5x CROSS for all three PAPER accounts. Initial entry target is 3% of CURRENT FREE CAPITAL in initial margin (not a 3% stop-loss): compute targetNotional = 0.03 * freeCapital * 5 and quantity rounded DOWN to verified lot. Use current equity minus existing gross initial margins and reserved adds, conservatively capped by native availableQuote. The native risk gate requires at least 3% initial margin for a fresh entry, but allows larger entries when structural stop risk and all portfolio/stress limits pass; 3% is NOT a ceiling. If structural ATR/H4 stop plus fee/slippage exceeds whole-idea limits, reduce quantity below target or no_trade; never narrow a stop to hit 3%. Existing positions can only be scaled in with their prior reserved capacity, independent confirmation and complete risk rechecks.",
              "To take 50% profit ONLY after verified mark exceeds 1.5 original-stop R, propose kind reduce with takePartialAndBreakEven:true and quantityBase exactly half of the actual held base quantity rounded DOWN to venue lot. Native executor independently checks 1.5R, the 50% amount, and observed market; only a VERIFIED NATIVE FILL can move remaining stop toward conservative cost-buffered BE. The executor never widens stop, and cannot guarantee funding recovery. Do not submit a separate tighten_stop before confirming the fill. Normal reduce without this optional flag remains supported.",
              "Use a stop and a profitable take-profit. Respect leverage, per-idea loss, daily loss, total open stop risk and position count caps. The supplied preset dollar budgets apply at initialBalanceQuote; scale them by current markedEquityQuote / initialBalanceQuote. Independent high-watermark drawdown rules can halve new idea/open budgets or block entries. Futures have NO legacy fixed USDT gross-exposure cap; a trusted equity-based portfolio stress guard checks the full gross exposure.",
              "A volatile wick can stop out a good thesis; use the advisory ATR/wick context and public candles to assess stop distance. The diagnostic is a descriptive sample, not a trading signal, not a liquidation guarantee and not authority to delete or widen an existing protective exit.",
              "Plan recovery BEFORE the FIRST new position: propose plannedRecoveryNotionalQuote in USDT only when the entry thesis includes future adds. Omit it or use zero for a single-entry idea; omit recoverySteps in that case. There is no automatic reserve minimum. This capacity is booked in the portfolio gross-stress, margin and stop-risk limits and cannot be spent on unrelated positions. Do NOT send automatic averaging orders. Explain why the reserve is enough or choose no_trade if the combined plan is unsafe.",
              "For a fresh new PAPER position with a POSITIVE reserve, supply recoverySteps of EXACTLY two objects: {stepId,triggerPriceQuote,allocationPercent}. Allocation percentages must be positive integers totaling 100, with distinct IDs, ordered toward the protective HARD stop; for Long: stop < second trigger < first trigger < entry, and for Short: entry < first trigger < second trigger < stop. The fixed hard stop must be FURTHER away than the deepest planned averaging level. If such a plan would exhaust risk/capital, propose no_trade or a smaller initial position; never widen an existing stop to fit.",
              "A recoverySteps plan books OPTIONAL positions; it never places standing averaging orders. The live verified quote must visit a particular trigger AFTER the initial position is open; then a new confirmed two-pivot/neckline reversal plus whole-account stress authorization is mandatory. For an addition specify recoveryStepId from the persisted protectionPlans. Do not invent triggered stages or override original limits.",
              "To scale into an existing position, use proposal.addToPositionId with a real matching position id, instrument, side, current leverage and EXACT existing stop/take-profit; each additional fill consumes the same whole-idea stop-loss risk. If the existing position is underwater, a new scale-in must pass the independent 20+ confirmed-candle two-pivot and neckline-break structure gate, PLUS a fresh whole-account risk check; a new lower low alone never licenses a fill. The technical pattern is not a guarantee.",
              "For addToPositionId, the requested add must fit the remaining pre-booked recovery reserve shown under protectionPlans, in addition to every fresh risk and chart confirmation. A bigger recovery reserve requires a separately auditable plan revision; you cannot silently use another idea's booked capacity.",
              "To free a slot for a hedge or rotate an inferior position, use proposal.replacePositionId (NOT with addToPositionId). This requests closing that position first and entering the new proposal ONLY if the old position is fully closed and fresh independent risk checks still pass. A partial unfilled exit means no new entry. Never assume a replacement succeeded.",
              "If verified market movement permits a strictly safer protective stop, choose tighten_stop with positionId and stopPriceQuote. For long the new stop must be HIGHER than the old one but still BELOW the current mark; for short LOWER than the old one but still ABOVE the current mark. Stops are never widened or removed, and an existing risk budget is not credited just because the stop moved.",
              "Evaluate the experiment by net expectancy, costs, drawdown and independent closed trades. Long holds, short holds and no_trade are permitted; never trade to meet a daily profit or activity quota. There is no universal required reward/risk ratio: explain the scenario and its costs.",
              "Stop loss must budget entry and exit at the highest nonnegative supplied maker/taker rate for that instrument and include the adverse slippage reserve. Fee rates are decimal fractions of filled notional, not margin; marketable limits can be taker. Round quantity DOWN to lotIncrementBase.",
              "This simulator uses account-wide margin. Reserve gross initial margin for BOTH hedge legs plus fees. While any position is open, use its existing leverage for all new entries; owner maxLeverage is a ceiling. Maintenance and funding consume equity.",
              "Only choose a position when the public evidence supports it. Otherwise explain no_trade. Never invent prices or balance fields.",
              "Respond in Russian in rationale/reason. Your proposal is independently checked and may be denied by execution rules.",
            ].join("\n"),
            skill: { provenance: prepared.provenance, content: prepared.skillContent },
            data: {
              researchUniverse: { fetchedAt: discovery.fetchedAt, rankedCandidates },
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
              futuresStressPolicy: {
                policyVersion: PAPER_PERPETUAL_RISK_POLICY_VERSION,
                adverseMarketMovePercent: 50,
                minimumEquityRemainingAfterStressPercent: 25,
                minimumGrossMaintenanceReservePercent: 2,
                grossHedgeLegsCountSeparately: true,
                noStaticNotionalCap: true,
                extremeScenariosAreDiagnosticOnly: true,
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
          : nativeResearchExecuted
            ? { provider: "native-public-rules", modelId: "okx-m15-h1-h4-v1" }
            : undefined,
    );
    if (!recorded) {
      // Entry permission may expire after protection but before research commit.
      // A held position still needs its next independently authorized wake.
      if (await reschedulePerpetualProtectionAfterResearchExpiry(deps.prisma, owner, key))
        await enqueueNext(deps, owner, key.ledgerId, key.revision);
      return;
    }
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
          ...(deps.engine && decision.kind === "proposal" ? [decision.instrument] : []),
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
    // A one-off public GET failure must not pause all owner-approved PAPER
    // entries. Only retries with unchanged revision and no live native orders;
    // persistent or nontransport faults continue through fail-closed pause.
    if (
      failure === "market_data_unavailable" &&
      isTransientPaperMarketNetworkError(error) &&
      (await retryTransientPerpetualMarketWake(deps.prisma, owner, key).catch(() => false))
    ) {
      await enqueueNext(deps, owner, key.ledgerId, key.revision);
      return;
    }
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
