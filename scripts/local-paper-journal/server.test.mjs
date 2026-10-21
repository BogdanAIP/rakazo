import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJournalGateway, validateConfig } from "./server.mjs";

const now = Date.parse("2026-01-01T00:00:00Z");
const raw = {
  publicOrigin: "http://127.0.0.1:5173",
  authApi: "http://127.0.0.1:3100",
  allowedUserId: "primary-user",
  paperApi: "http://127.0.0.1:3008",
  paperOrigin: "http://localhost:5188",
  paperSpaceId: "paper-space",
  procedures: ["trading/perpetualJournalList", "trading/perpetualWorkspaceCommand"],
  expiresAt: "2026-01-02T00:00:00Z",
  credentialEnv: "TEST_PAPER_GRANT",
  assetsDir: path.resolve(os.tmpdir(), "fake-journal-assets"),
  port: 5190,
};
const credential = `rkg_${"a".repeat(43)}`;
const config = () => validateConfig(raw, { TEST_PAPER_GRANT: credential });
const goodSession = {
  user: { id: "primary-user" },
  session: {
    userId: "primary-user",
    expiresAt: "2026-01-02T00:00:00Z",
  },
};
const json = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function request(procedure = "trading/perpetualJournalList", options = {}) {
  return new Request(`${raw.publicOrigin}/linked-paper/rpc/${procedure}`, {
    method: "POST",
    headers: {
      origin: raw.publicOrigin,
      cookie: "session=fake",
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body ?? '{"json":{}}',
    ...options,
  });
}
function harness(session = goodSession, upstream = () => json({ json: { mode: "paper_only" } })) {
  const calls = [];
  const handle = createJournalGateway(
    config(),
    async (url, init) => {
      calls.push({ url, init });
      return url.includes("/api/auth/") ? json(session) : upstream(url, init);
    },
    () => now,
  );
  return { calls, handle };
}

test("exact owner session gates linked data; upstream never receives primary credentials or caller space", async () => {
  const { handle, calls } = harness();
  const r = await handle(
    new Request(request().url, {
      method: "POST",
      body: '{"json":{}}',
      headers: {
        origin: raw.publicOrigin,
        cookie: "session=fake",
        authorization: "Bearer primary",
        "x-rakazo-space-id": "attacker-space",
        "x-rakazo-user-id": "attacker",
        "content-type": "application/json",
      },
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer primary");
  assert.equal(calls[1].init.headers.authorization, `Bearer ${credential}`);
  assert.equal(calls[1].init.headers.cookie, undefined);
  assert.equal(calls[1].init.headers["x-rakazo-space-id"], raw.paperSpaceId);
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("no session makes no upstream call", async () => {
  const { handle, calls } = harness();
  const r = await handle(
    new Request(request().url, {
      method: "POST",
      body: "{}",
      headers: {
        origin: raw.publicOrigin,
        "content-type": "application/json",
      },
    }),
  );
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});
test("another primary account cannot use the link or forge actor headers", async () => {
  const { handle, calls } = harness({ ...goodSession, user: { id: "other-user" } });
  const r = await handle(request());
  assert.equal(r.status, 403);
  assert.equal(calls.length, 1);
});
test("expired primary session cannot read linked account", async () => {
  const { handle, calls } = harness({
    ...goodSession,
    session: { expiresAt: new Date(now).toISOString() },
  });
  assert.equal((await handle(request())).status, 401);
  assert.equal(calls.length, 1);
});
test("revoked primary session checked on every call", async () => {
  let active = true,
    paperCalls = 0;
  const handle = createJournalGateway(
    config(),
    async (url) =>
      url.includes("/api/auth/")
        ? json(active ? goodSession : null)
        : (() => {
            paperCalls++;
            return json({ json: {} });
          })(),
    () => now,
  );
  assert.equal((await handle(request())).status, 200);
  active = false;
  assert.equal((await handle(request())).status, 401);
  assert.equal(paperCalls, 1);
});
test("expired finite grant never renews or forwards", async () => {
  const { calls } = harness();
  const handle = createJournalGateway(
    { ...config(), expiresAt: new Date(now).toISOString() },
    async (url, init) => {
      calls.push({ url, init });
      return json(goodSession);
    },
    () => now,
  );
  assert.equal((await handle(request())).status, 410);
  assert.equal(calls.length, 1);
});
test("unlinked or encoded procedures fail closed without auth or upstream", async () => {
  const { handle, calls } = harness();
  for (const p of ["users/delete", "trading/perpetualJournalList%2fextra", "trading/journalRead"]) {
    assert.equal((await handle(request(p))).status, 403);
  }
  assert.equal(calls.length, 0);
});
test("cross-origin and missing-origin POST cannot execute commands", async () => {
  const { handle, calls } = harness();
  for (const origin of ["https://untrusted.invalid", "null", ""]) {
    const r = await handle(
      new Request(request().url, {
        method: "POST",
        body: "{}",
        headers: { cookie: "session=fake", origin, "content-type": "application/json" },
      }),
    );
    assert.equal(r.status, 403);
  }
  assert.equal(calls.length, 0);
});
test("wrong method/content type cannot execute", async () => {
  const { handle, calls } = harness();
  assert.equal((await handle(new Request(request().url))).status, 405);
  assert.equal(
    (
      await handle(
        new Request(request().url, {
          method: "POST",
          body: "{}",
          headers: { origin: raw.publicOrigin, "content-type": "text/plain" },
        }),
      )
    ).status,
    415,
  );
  assert.equal(calls.length, 0);
});
test("auth transport failures fail closed", async () => {
  const handle = createJournalGateway(
    config(),
    async () => {
      throw Error("private detail");
    },
    () => now,
  );
  const r = await handle(request());
  assert.equal(r.status, 503);
  assert.ok(!(await r.text()).includes("private detail"));
});
test("upstream rejection is propagated once, without response cookies", async () => {
  const { handle, calls } = harness(goodSession, () =>
    json({ json: "denied" }, 403, { "set-cookie": "private=fake" }),
  );
  const r = await handle(request());
  assert.equal(r.status, 403);
  assert.equal(calls.length, 2);
  assert.equal(r.headers.get("set-cookie"), null);
});
test("transport error is not retried for commands", async () => {
  const { handle, calls } = harness(goodSession, () => {
    throw Error(credential);
  });
  const r = await handle(request("trading/perpetualWorkspaceCommand"));
  assert.equal(r.status, 502);
  assert.equal(calls.length, 2);
  assert.ok(!(await r.text()).includes(credential));
});
test("redirect and credential-bearing responses cannot escape", async () => {
  for (const upstream of [
    () => new Response(null, { status: 302, headers: { location: "https://untrusted.invalid" } }),
    () => json({ error: credential }),
  ]) {
    const { handle } = harness(goodSession, upstream);
    assert.equal((await handle(request())).status, 502);
  }
});
test("oversized command never reaches paper", async () => {
  const { handle, calls } = harness();
  assert.equal(
    (
      await handle(
        request("trading/perpetualWorkspaceCommand", { body: "x".repeat(1024 * 1024 + 1) }),
      )
    ).status,
    503,
  );
  assert.equal(calls.length, 1);
});
test("configuration refuses remote origins, wildcard scope and missing credentials", () => {
  for (const change of [
    { paperApi: "https://untrusted.invalid" },
    { authApi: "http://127.0.0.1:3100/else" },
    { paperOrigin: "http://user:pass@127.0.0.1:3008" },
    { procedures: ["trading/*"] },
    { credentialEnv: "MISSING" },
    { expiresAt: "bad" },
    { extra: true },
  ])
    assert.throws(() => validateConfig({ ...raw, ...change }, { TEST_PAPER_GRANT: credential }));
});
test("view requires primary session; static files cannot traverse outside assets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linked-paper-test-"));
  try {
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "index.html"), "<main>fake journal</main>");
    await writeFile(path.join(dir, "assets", "journal.js"), "export const fake=true;");
    const handle = createJournalGateway(
      { ...config(), assetsDir: dir },
      async () => json(goodSession),
      () => now,
    );
    const view = `${raw.publicOrigin}/linked-paper/view`;
    assert.equal((await handle(new Request(view))).status, 401);
    const r = await handle(new Request(view, { headers: { cookie: "session=fake" } }));
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-security-policy").includes("frame-ancestors"));
    assert.equal(
      (await handle(new Request(`${raw.publicOrigin}/linked-paper/assets/journal.js`))).status,
      200,
    );
    for (const relative of [
      "assets/%2e%2e%2fserver.mjs",
      "assets/private.json",
      "view/../server.mjs",
    ])
      assert.notEqual(
        (await handle(new Request(`${raw.publicOrigin}/linked-paper/${relative}`))).status,
        200,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
