import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJournalGateway, validateConfig } from "./server.mjs";

const at = Date.parse("2026-10-19T17:30:00.000Z");
const auth = {
  user: { id: "owner" },
  session: { userId: "owner", expiresAt: "2026-10-30T12:00:00.000Z" },
};
const fakeGrant = "rkg_" + "x".repeat(43);
async function fixture(work, paperRpc, extraProcedures = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-offline-auth-"));
  const assets = path.join(root, "journal-assets");
  await mkdir(assets);
  const config = validateConfig(
    {
      publicOrigin: "http://127.0.0.1:5173",
      authOrigin: "http://127.0.0.1:5173",
      authApi: "http://127.0.0.1:3100",
      allowedUserId: "owner",
      paperApi: "http://127.0.0.1:3008",
      paperOrigin: "http://localhost:5188",
      paperSpaceId: "paper-space",
      procedures: [
        "trading/perpetualJournalRead",
        "trading/perpetualJournalList",
        "trading/perpetualWorkspaceRead",
        ...extraProcedures,
      ],
      expiresAt: "2026-10-30T16:28:11.539Z",
      credentialEnv: "TEST_PAPER_GRANT",
      assetsDir: assets,
      port: 5190,
    },
    { TEST_PAPER_GRANT: fakeGrant },
  );
  let calls = 0;
  const gateway = createJournalGateway(
    config,
    async (url, init) => {
      calls++;
      const result = url.includes("/api/auth/")
        ? auth
        : paperRpc
          ? await paperRpc(url, init)
          : auth;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    () => at,
  );
  const req = (cookie = "session=test", suffix = "") =>
    new Request("http://127.0.0.1:5173/linked-paper/offline-review" + suffix, {
      headers: cookie ? { cookie } : {},
    });
  try {
    await work({ root, gateway, req, calls: () => calls });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("offline review is authenticated and never reveals marker to a visitor", async () => {
  await fixture(async ({ gateway, req, calls }) => {
    assert.equal((await gateway(req(""))).status, 401);
    assert.equal(calls(), 0);
    assert.equal((await gateway(req("session=test", "?leak=1"))).status, 404);
  });
});
test("missing marker is neutral, never proof of successful history audit", async () => {
  await fixture(async ({ gateway, req }) => {
    const r = await gateway(req());
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { state: "no_record", reviewPending: false });
  });
});
test("recorded offline interval requires both funding and stop review, no synthetic fills", async () => {
  await fixture(async ({ root, gateway, req }) => {
    await writeFile(
      path.join(root, "paper-offline-lifecycle.json"),
      JSON.stringify({
        version: 1,
        mode: "PAPER_ONLY",
        state: "resumed_review_pending",
        stoppedAtUtc: "2026-10-19T17:06:57.632Z",
        resumedAtUtc: "2026-10-19T17:22:08.798Z",
        reviewRequired: true,
        ownerSecret: "should-not-leak",
      }),
    );
    const r = await gateway(req());
    assert.equal(r.status, 200);
    const o = await r.json();
    assert.equal(o.durationSeconds, 911);
    assert.equal(o.state, "resumed_review_pending");
    assert.equal(o.reviewPending, true);
    assert.equal(o.fundingReview, "required");
    assert.equal(o.stopTargetReview, "not_verified");
    assert.equal(o.syntheticFills, false);
    assert.equal(o.mayAuthorizeEntries, false);
    assert.ok(!JSON.stringify(o).includes("ownerSecret"));
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
});
test("corrupt or untrusted marker fails closed", async () => {
  await fixture(async ({ root, gateway, req }) => {
    const marker = path.join(root, "paper-offline-lifecycle.json");
    await writeFile(
      marker,
      JSON.stringify({
        mode: "LIVE_TRADING",
        state: "offline",
        stoppedAtUtc: "2026-10-19T17:00:00Z",
      }),
    );
    assert.equal((await gateway(req())).status, 503);
    await writeFile(marker, "not json");
    assert.equal((await gateway(req())).status, 503);
  });
});

test("offline review includes safe account states using existing linked read-only RPC", async () => {
  const calls = [];
  await fixture(
    async ({ root, gateway, req }) => {
      await writeFile(
        path.join(root, "paper-offline-lifecycle.json"),
        JSON.stringify({
          mode: "PAPER_ONLY",
          state: "resumed_review_pending",
          stoppedAtUtc: "2026-10-19T17:00:00.000Z",
          resumedAtUtc: "2026-10-19T17:10:00.000Z",
        }),
      );
      const r = await gateway(req());
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.ok(data.accounts, JSON.stringify({ data, calls }));
      assert.deepEqual(data.accounts, [
        {
          strategy: "aggressive",
          sessionStatus: "paused",
          phase: "protection_only",
          pendingOrders: 0,
          protectivePlans: 1,
        },
      ]);
      assert.equal(data.mayAuthorizeEntries, false);
      assert.deepEqual(
        calls.map((x) => x.procedure),
        ["trading/perpetualJournalList", "trading/perpetualWorkspaceRead"],
      );
      assert.ok(calls.every((x) => !JSON.stringify(x).includes("ownerSecret")));
    },
    async (url, init) => {
      const procedure = url.split("/rpc/")[1];
      calls.push({
        procedure,
        authorization: init.headers.authorization === "Bearer " + fakeGrant,
      });
      if (procedure === "trading/perpetualJournalList")
        return { json: { mode: "paper_only", ledgers: [{ ledgerId: "paper-futures:one" }] } };
      return {
        json: {
          status: "verified",
          ledgerId: "paper-futures:one",
          strategy: "aggressive",
          sessionStatus: "paused",
          phase: "protection_only",
          openOrders: [],
          positionPlans: [{ positionId: "sol" }],
        },
      };
    },
  );
  assert.ok(calls.every((x) => x.authorization));
});
test("offline H1 stop wick is evidence only and cannot create a retrospective fill", async () => {
  const procedures = [];
  const market = {
    venue: "okx",
    kind: "perpetual",
    symbol: "SOL-USDT-SWAP",
    base: "SOL",
    quote: "USDT",
    status: "active",
    priceIncrement: "0.01",
    quantityIncrement: "0.1",
    minNotional: null,
    expiryAt: null,
  };
  await fixture(
    async ({ root, gateway, req }) => {
      await writeFile(
        path.join(root, "paper-offline-lifecycle.json"),
        JSON.stringify({
          mode: "PAPER_ONLY",
          state: "resumed_review_pending",
          stoppedAtUtc: "2026-10-19T15:00:00.000Z",
          resumedAtUtc: "2026-10-19T16:00:00.000Z",
          reviewRequired: true,
        }),
      );
      const response = await gateway(req());
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.marketReviews?.length, 1, JSON.stringify(result));
      const evidence = result.marketReviews[0];
      assert.equal(evidence.instrument, "SOL-USDT-SWAP");
      assert.equal(evidence.status, "stop_possible");
      assert.equal(evidence.barsReviewed, 1);
      assert.equal(evidence.executionVerified, false);
      assert.equal(evidence.newEntriesAuthorized, false);
      assert.equal(result.mayAuthorizeEntries, false);
      assert.ok(!JSON.stringify(result).includes("fillPrice"));
      assert.ok(procedures.every((p) => p !== "trading/perpetualWorkspaceCommand"));
    },
    async (url, init) => {
      if (url.startsWith("https://www.okx.com/")) {
        assert.equal(init.method, "GET");
        assert.equal(init.headers.authorization, undefined);
        return {
          code: "0",
          data: [
            [
              String(Date.UTC(2026, 9, 19, 15)),
              "104",
              "108",
              "102",
              "103",
              "2",
              "208",
              "100000",
              "1",
            ],
          ],
        };
      }
      const procedure = url.split("/rpc/")[1];
      procedures.push(procedure);
      if (procedure === "trading/perpetualJournalList")
        return { json: { mode: "paper_only", ledgers: [{ ledgerId: "paper-futures:one" }] } };
      if (procedure === "trading/perpetualWorkspaceRead")
        return {
          json: {
            ledgerId: "paper-futures:one",
            status: "verified",
            strategy: "aggressive",
            sessionStatus: "paused",
            phase: "protection_only",
            openOrders: [],
            positionPlans: [
              {
                positionId: "sol",
                stopPriceQuote: "106.8",
                takeProfitPriceQuote: "98.8",
              },
            ],
          },
        };
      if (procedure === "trading/catalog") return { json: { markets: [market] } };
      if (procedure === "trading/perpetualJournalRead")
        return {
          json: {
            status: "verified",
            state: {
              openPositions: [
                {
                  positionId: "sol",
                  venue: "okx",
                  instrument: "SOL-USDT-SWAP",
                  side: "short",
                },
              ],
            },
          },
        };
      throw Error("Unexpected PAPER procedure");
    },
    ["trading/catalog"],
  );
});
test("more than three PAPER accounts fail closed instead of hiding a fourth", async () => {
  await fixture(
    async ({ root, gateway, req }) => {
      await writeFile(
        path.join(root, "paper-offline-lifecycle.json"),
        JSON.stringify({
          mode: "PAPER_ONLY",
          state: "resumed_review_pending",
          stoppedAtUtc: "2026-10-19T15:00:00.000Z",
          resumedAtUtc: "2026-10-19T16:00:00.000Z",
        }),
      );
      const response = await gateway(req());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.accountsStatus, "unavailable");
      assert.equal(body.accounts, undefined);
      assert.equal(body.mayAuthorizeEntries, false);
    },
    async () => ({
      json: {
        mode: "paper_only",
        ledgers: [
          { ledgerId: "paper-futures:a" },
          { ledgerId: "paper-futures:b" },
          { ledgerId: "paper-futures:c" },
          { ledgerId: "paper-futures:d" },
        ],
      },
    }),
  );
});
