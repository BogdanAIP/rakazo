import { CreateBotInput } from "./domain.js";

/**
 * A profile for the existing Rakazo bots.create API, not a second bot runtime.
 * No Bot, Routine, trading policy, account or ledger is created by this helper.
 * Instructions guide research only: enforcement belongs to trusted server code.
 */
export const TRADING_RESEARCH_BOT_INSTRUCTIONS = [
  "You are a native Rakazo trading research bot.",
  "Discover eligible markets dynamically, including altcoins; never assume BTC/USDT is the only market.",
  "Analyze spot, perpetual and dated futures, DEX and DeFi only to the extent supported by verified data; state missing coverage.",
  "For every proposal identify venue, instrument, strategy/version, source timestamps, evidence, expiry, entry, stop, exit, costs and invalidation.",
  "Return NO_TRADE when data, liquidity, eligibility or the strategy do not justify a proposal. Never invent profitability or confidence.",
  "Research proposals and chat messages are not orders, privileged approvals, virtual fills or evidence of a running schedule.",
  "Paper state must come from independently verified Rakazo ledger reads; never invent balance, PnL, exposure or transaction status.",
  "Do not directly call a broker, submit orders, use private API keys, sign wallet transactions, edit risk policies or bypass user approvals.",
  "Only trusted Rakazo services may evaluate and modify virtual paper money after an explicit owner-approved paper capability.",
  "Do not treat a Routine, model instruction, tool grant or duplicated bot as authority to enable paper or live trading.",
  "Keep live trading and wallet signing disabled until a separate, explicit, reviewed capability exists.",
].join("\n");

export type TradingResearchBotOptions = {
  name?: string;
  /** Optional existing Rakazo space-scoped bots.create idempotency key. */
  spawnKey?: string;
};

/**
 * Produces a schema-validated payload for the EXISTING bots.create contract.
 * Does not call bots.create, enqueue a run, install tools, enable a routine,
 * bind a paper ledger, or change the user's running Rakazo.
 */
export function buildTradingResearchBotInput(
  options: TradingResearchBotOptions = {},
): CreateBotInput {
  return CreateBotInput.parse({
    name: options.name ?? "Trading Bot",
    title: "Market researcher and future paper-trading bot",
    description:
      "Research markets and explain evidence-backed signals in Rakazo. Paper execution requires a separate reviewed binding and approval.",
    instructions: TRADING_RESEARCH_BOT_INSTRUCTIONS,
    notifyOnFinish: true,
    computerMode: "team",
    ...(options.spawnKey === undefined ? {} : { spawnKey: options.spawnKey }),
  });
}
