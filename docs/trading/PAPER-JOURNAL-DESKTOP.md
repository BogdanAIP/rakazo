# PAPER journal on the Windows desktop

## Status

This is a **read-only** human dashboard over the already existing
transactional PostgreSQL PAPER Ledger. It does not create another ledger
or connect to a real broker.

After this branch has been integrated and deployed, open the Rakazo app
in a browser and navigate to:

`/app/paper-journal`

The route requires the user's normal Rakazo session. It offers:

- owner/space-scoped selection between existing ledgers;
- available and reserved virtual currency, realized PnL and fees;
- open virtual positions and event history with older-page pagination;
- explicit integrity-blocked UI instead of unverified financial values;
- a **Download desktop shortcut** button.

Click the shortcut button and move the downloaded
`Rakazo-PAPER-Journal.url` file onto the Windows Desktop. Double-click
it to open the same journal screen later in the default browser.

The link is generated from `window.location.origin`. It works with the
actual address/port/HTTPS origin, not a guessed localhost port, and
contains **no** session token, password, ledger ID or private key.

## Ownership and accounting safety

`trading.journalList` and `trading.journalRead` are read-only,
authenticated user-interface endpoints, not bot tools.

- Both routes use the authenticated actor's `spaceId` AND `userId`;
  the journal reader declines cross-owner and cross-space IDs before
  verifying the journal.
- Monetary fields are only returned after replay hash-chain and strict
  managed-paper lifecycle verification. Integrity failures suppress
  balances and event history.
- Event pages are at most 100 records; listing is capped at 50 ledgers.
- No RPC for raw journal append, reserve, buy, sell, account keys, private
  exchange access, approval-control changes, or outbox dispatch exists.
- The screen explicitly labels book equity as **not mark-to-market**.
- An unreadable, unaudited or nonexistent journal must never be
  treated as a zero-loss or verified journal.

## Deployment and access

This feature lives in a separate draft PR and is **not** active in any
installed Rakazo until the reviewed branch is integrated and deployed.
A desktop shortcut can be created in the page after that; creating the
shortcut alone does not install or deploy the journal viewer.

If the user is signed out, the link routes them to normal sign-in.
It does not skip Rakazo authorization.

## Future enhancements

Later iterations may add symbol filters, CSV export of verified rows,
and strategy/Market Skill attribution from the immutable trading
provenance. Those features are not prerequisites for opening the
existing journal from the desktop.
