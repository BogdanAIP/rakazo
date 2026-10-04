# P12 — Native Rakazo Trading Bot (stacked after P11C-7)

Status (2026-10-04): **P12-0 profile and P12-1A binding implemented in stacked DRAFTs; P12-1B guarded writes in further stacked DRAFT; no Bot/Worker deployed**.
Source branch: `feature/rakazo-trading-native-bot-2026-10-04`, based on P11C-7 / PR #12.
This is the implementation-slice sequence P0–P12, distinct from the broad product-phase table in ROADMAP.md.

## Product decision

The deliverable is a **user-created native Rakazo Bot**, visible and manageable in the ordinary Bots UI.
It is not a second daemon, separate trading website, external LLM agent, independent planner or substitute for the existing Bot/Run/Routine architecture. Users may create multiple bots, each with its own versioned strategy, research history, scoped paper portfolio and later separately authorized capabilities. Bot instructions are advisory, **never** the security/financial authorization boundary.

The existing contract already provides `bots.create/get/update/archive/restore/duplicate`, a Bot-scoped Thread, Runs, Tasks, Memory, Scratchpad and disabled-by-default Routines. `bots.create` enqueues a normal introductory run; merely preparing a bot profile must therefore not call it or silently create/activate a live user bot. The existing `routines.create` defaults `active=false`; its prompt/cron is not an order gateway. Native bot model/provider configuration remains the owner's normal Rakazo setting, not a new trading-specific inference service.

### P12-0 — safe native profile, implemented

`packages/contracts/src/trading-bot.ts` exports `buildTradingResearchBotInput()` producing a validated **existing** `CreateBotInput`, and a research-only instruction template. No new Bot schema, privileged tool, trading scheduler, RPC write, migration, account, key, portfolio or deployed Bot is created. A native UI or an authenticated explicit user action can later call `bots.create` with this ordinary payload. Defaults do not opt the bot into dedicated computer control. Its profile explicitly distinguishes market research / timestamped evidence / NO_TRADE from independent approval and virtual finance.

A user-facing product should display **Trading Bot** in the ordinary Bot creation experience and, when implemented, choose the template there. Do not add a special bot-control service. A ChatGPT/Plugin R interaction can supervise that same bot; it must not become a second durable portfolio authority.

## P12-1 — durable, immutable Bot ↔ paper-ledger binding (incremental)

P10/P11 legacy ledgers originally scope by `spaceId + ownerUserId` but not `botId`. New P12-1A ledgers carry a creation-time nullable `botId`, **NULL for all pre-existing P10/P11 ledgers**, unique and FK-bound to the native Rakazo Bot. The Bot identity check and immutable financial entry boundary are being integrated incrementally; do not describe P11 or P12-1A as a finished user-facing trading Bot.

### P12-1A implemented in this stacked branch

- A nullable unique `TradingPaperLedger.botId` with a native Bot relation; SQL `ON DELETE RESTRICT` and a trigger prohibit changing this field after insertion (including legacy NULL). No retroactive migration or automatic Bot assignment.
- `createTradingBotPaperLedger` creates the inert P10 journal and binds one authenticated **active** same-owner/same-space Bot inside one serializable transaction, using a server-minted journal ID and timestamp. A row lock plus uniqueness prevent two independently pooled creators from binding the same Bot. The ordinary legacy `createTradingPaperLedger` remains unbound.
- `requireTradingBotPaperBindingInTransaction` checks membership, Bot/owner/space/ledger and optionally the Run ID in the caller's transaction; archive bypass is for trusted recovery, not new trading. `readTradingBotPaperBinding` returns only identity (no unaudited balances).
- For **bound** ledgers, existing explicit B6 approval now validates that the effect's `run.botId` is the linked Bot; a wrong Bot's valid owner-scoped Run fails without consuming the approval. Enabling on an archived Bot is denied; an already approved disable can latch on an archived Bot.
- The existing `bots.remove` handler refuses deletion of a bound Bot and directs the owner to archive it; SQL FK protects against direct deletion. Duplicating a Bot via existing UI creates a new Bot identity and cannot duplicate the unique ledger relationship.
- Dedicated isolated PostgreSQL tests cover concurrent allocation, cross-Bot/owner/space access, foreign-run approval, archival recovery/disable, legacy unbound records, trigger immutability, FK preservation and zero virtual journal events at allocation. Tests run only when the disposable testkit supplies `VERIFY_DATABASE`.

**P12-1A does NOT expose a Bot-facing money writer, scheduler, user API or paper tool; it does not install/run a Bot.** New Bot-bound ledgers start with no risk policy and cannot reserve until separate explicit policy/approval and the remaining writer guards are finished. P11 legacy owner-scoped internal primitives remain as before for regression compatibility. This is an isolated schema and trusted-service foundation, not the activation of a new execution mode.

### P12-1B guarded internal journal paths (this stacked DRAFT)

P12-1B requires a trusted, service-derived `PaperBotCaller` on **bound** ledgers at the same serializable transaction boundary: reserve, fill_buy, stop-triggered fill_sell, expiration/kill-switch release, reconciliation, verified recovery status and the underlying direct synthetic journal append. An absent/foreign Bot is rejected before any idempotent prior-result read or virtual-money mutation; a Bot caller cannot adopt a legacy NULL journal. A caller's optional Run must belong to the same Bot, owner and space. These typed internal parameters are **not** model-facing RPC/MCP tools and do not themselves provide execution approval.

`new_exposure` requires an active native Bot; `protective` close/release and verified `recovery` allow the exact bound Bot after archive to avoid stranding protective operations. Existing explicit B6 owner approval still gates enable/disable, and approved disable passes its originating Run identity through reservation release. The old P11 internal functions retain their legacy NULL-ledger behavior and test coverage. No routine/scheduler or live broker is activated.

Disposable PostgreSQL regression tests exercise unscoped and foreign-Bot denial on reserve/fill/stop-close/reconcile/recovery/direct append, zero added journal events, owner recovery after archive and denial of new exposure. Each new Bot-facing adapter must derive the caller from authenticated context, **not** from AI-generated text or a user-editable prompt. This slice does not add a generic Bot-facing write endpoint. Additional E2E approval/restart and protective-stop lifecycle testing remains a gate before automatic Paper execution.

### P12-1C — required before automatic Paper activation
 Add a migration and a trusted creation/binding service, with all of these invariants:

1. Lookup authenticated current `Bot` inside the same serializable transaction: matching `spaceId`, owner `userId`, active/non-archived status and non-deleting Space membership. An arbitrary botId or AI claim must not stand in for authentication.
2. Initial supported shape: **one bound paper ledger per native Bot** and one native Bot per ledger. Distinct bots must never share synthetic funds, signal IDs, approvals or paper stop guards merely because the owner matches. Prefer an explicit durable relation with uniqueness/FK and deletion-safe preservation; do not use bot name, prompt, model, `spawnKey` or mutable instructions as the financial identifier.
3. Preserve pre-existing P10/P11 ledgers as **legacy unbound** (or migrate only with explicit verified owner selection), disabled from Bot-driven money operations until independently audited and bound. Do not silently assign historical money to a new or duplicated Bot.
4. Bind policy/revision, ledger and approved effect to the Bot identity. A `paper_trading_control` request from a Run must validate that `run.botId` matches the bound Bot and actor/space; prior ledger-only permission does not automatically transfer to a new bot. Do not make LLM output, a Routine or a generic tool grant a paper-capability approval.
5. Keep strict P11C3 audit and its C4 fail-closed writer barrier as the single authoritative virtual-money entry boundary; verify Bot scope and ledger binding **within the same** serializable operation for reserve, fill, stop close, reconcile, recovery and approval. Explicit owner kill-switch/disable must remain possible even when a Bot is archived or journal provenance is corrupt; preserve C4's disabled-with-reconciliation-required behavior.
6. A duplicate Bot copies only the regular user-visible research profile, not ledger, permissions, held funds, secrets, pending routines or prior approvals. Archiving or deleting a Bot cannot orphan or cascade-delete accounting evidence; no automatic liquidation. Archiving blocks new candidates and leaves independent recovery/disable available to the owner.
7. Extend lifecycle evidence and user status to include the durable Bot binding without representing a journal hash as cryptographic exchange attestation. No raw trusted DB writer becomes an ordinary AI/MCP/RPC tool.

Acceptance: same-space cross-bot denial, cross-user/cross-space denial, archive/restore and duplicate behavior, immutable binding, legacy-unbound rejection, two independent PostgreSQL connections racing allocation, failed release/disable safety, restart recovery and exact prior P11C7 same-evidence terminal retry. Migration must be tested on a disposable database only before review; user installation remains unchanged.

## P12-2 — native Bot interaction and research workflow

- Bot Thread is the conversation. The bot researches dynamically discovered instruments (including altcoins), emits evidence-bound concrete proposals **or NO_TRADE**, explains fees, source age and assumptions. The user's connected model/provider is chosen through normal Rakazo Bot settings.
- Use existing Rakazo Tasks/Runs/Memory/Artifacts/Scratchpad for strategy versions, research and audit references. Do not treat editable memory/instructions as authoritative virtual account balances, permission state or price provenance.
- Read-only portfolio/status/reporting should use verified ledger recovery and redact monetary numbers on `integrity_blocked`. A bot should distinguish "not configured", "research-only", "paper disabled", "paper approved", "reconciliation required" and later *separate* live mode.
- Existing Routine may schedule **research/reporting** after opt-in; model prompts cannot directly invoke trusted paper financial writers. A future deterministic Rakazo Worker-owned paper ticker/scheduler requires P12-1, independent checks, bounded jobs, leases, deduplication, crash tests and a separate owner approval. The chat connection is not its timing/safety loop.
- No default webhook, cron, startup task or always-on VPS. Plugin R reuses existing contract and permissions; no extra MCP tunnel.

## P12-3 — user-visible Bot configuration (future)

In the ordinary bot view, progressively expose Trading: Discovery, Signals, Strategies, Paper, Journal, Risk and Connections. Start with research/NO_TRADE and a *verified* read-only paper status. Display linked ledger ID, mode, risk revision, timestamps, missing evidence and approval history. A normal Bot "Run" does not enable paper or live trading. A separate explicit owner approval controls paper-only capability and a visible independent kill switch; no Auto Review / Always Allow bypass. Keep derivatives/DEX/DeFi as research until independently tested risk and execution gates.

## Non-goals / security gates

P12-0 does NOT create a Bot on the user's machine, persist a Bot↔ledger relation, start a Routine, attach a wallet, submit exchange orders or turn on an outbox dispatcher. P11 virtual ledger remains synthetic/full-fill spot only. Live CEX, derivative leverage, DEX signing and DeFi allocation are later individually authorized projects. No profit promise, fabricated signals, automatic strategy promotion or unrestricted model access to credentials.

Implementation sequence: P12-0 template + offline tests → P12-1A insert-only Bot relation and scoped allocation/approval (draft) → P12-1B transaction-local Bot guards (draft) → P12-1C integration and adversarial full protective/restart verification → P12-2 native Bot research/reporting integration → P12-3 UI/approvals → separately reviewed paper Worker activation. Keep every PR stacked/draft until acceptance and explicit rollout.
