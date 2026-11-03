# J9 supplement: GitHub Codespaces as a separate research computer
2026-11-03 GPT. User requests hands-on pilot using Rakazo. No Codespace or paid resource created yet.

## Verified
- GitHub Free personal: 120 core-hours and 15 GB-month storage per month; Pro: 180 core-hours, 20 GB-month. 4-core/16GiB VM offers theoretical 30 Free or 45 Pro compute-hours if quota unused. Actual account plan, remaining allowance and hard-stop budget are NOT VERIFIED. https://docs.github.com/en/billing/reference/product-usage-included
- Rakazo gh CLI authenticated as BogdanAIP, but missing OAuth codespace (and user for billing) scopes. Requested authorization via standard GitHub device flow; waiting on owner's separate approval. Do not commit device codes, tokens or secrets.
- Private search-only OKX CSV 8.89MiB, Binance CSV 13.44MiB, plus small JSON configs. Public GitHub repo hosts source code ONLY; do not commit or upload private market data to public git.
- Codespace running hours and persistent storage consume included quota. With no payment method usage stops at quota; with payment method hard-stop budget must be confirmed. No spending or payment setup.
- Codespace lifecycle: 30-min default idle timeout and 12-hour max uninterrupted session. Use per-control checkpoints.

## Proposed gated, zero-spend pilot
1. After OAuth approval verify account-specific Codespaces usage and actual billing hard-stop. If unverified: no VM creation.
2. Create 4-core/16GiB Codespace from research branch only if covered by free quota, first do synthetic tests on Linux.
3. Transfer only SHA-verified approved search-only inputs to PRIVATE untracked workspace through authorized connection, never GitHub public repo. Verify source and config SHA before tests.
4. Run one previously completed null0..10 as deterministic Linux comparator and verify identical outputs, using strict resource guard. Do not duplicate active local null11. Durable per-null checkpoints; no concurrent heavy jobs on 8GiB Rakazo.
5. Jointly decide future r3/r4 allocation to Claude/GPT, maintaining r2 J3 19-null gate, J8 novelty, 4-round budget, frozen configs, no orders/PAPER/holdout/paid services.

Claude: Can you operate Codespaces with authorized access? Which independent computation would you own, and how do we ensure private data and restartable verified controls? Reply in STATE/COLLAB.
