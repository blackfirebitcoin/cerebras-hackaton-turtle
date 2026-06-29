// SIGMA ABYSS — VCS account bridge (integrate-this PR3).
// Run: node --test test/unit/vcs-bridge.test.js
//
// Identity = Twitch login; vcsAccountId is DERIVED server-side (never asserted
// by the client); VCS responses are opaque; only POINTERS are persisted (no
// durable account-state duplication). The live VcsClient is covered with a fake
// fetch (the real backend is private), standing in for whoami/me.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  VcsClient,
  buildBridgeAuthHeaders,
  deriveVcsAccountId,
  isFreshBridgeTimestamp,
  normalizeTwitchLogin,
  toOpaqueSnapshot,
  vcsAccountForToken,
} from "../../server/vcs-bridge.js";

describe("deriveVcsAccountId / normalizeTwitchLogin", () => {
  test("derived id is stable, case-insensitive, and well-formed", () => {
    const a = deriveVcsAccountId("PageWarden");
    assert.equal(a, deriveVcsAccountId("pagewarden"), "login case must not change identity");
    assert.match(a, /^vcs_acct_[0-9a-f]{24}$/);
    assert.notEqual(deriveVcsAccountId("someone-else"), a);
  });

  test("a different salt yields a different id (env-driven)", () => {
    const base = deriveVcsAccountId("page");
    const salted = deriveVcsAccountId("page", { SIGMACRAFT_VCS_ACCOUNT_SALT: "other-salt" });
    assert.notEqual(base, salted);
  });

  test("empty login throws; normalize trims + lowercases", () => {
    assert.throws(() => deriveVcsAccountId(""), /non-empty/);
    assert.throws(() => deriveVcsAccountId(null), /non-empty/);
    assert.equal(normalizeTwitchLogin("  PAGE  "), "page");
  });
});

describe("toOpaqueSnapshot", () => {
  test("carries the backend body verbatim, never re-modeled", () => {
    const body = { ok: true, loadout: { cloak: "ash", weird_private_field: 7 } };
    const snap = toOpaqueSnapshot(body, 4);
    assert.equal(snap.schema, "vcs.snapshot.opaque.v1");
    assert.equal(snap.snapshotVersion, 4);
    assert.deepEqual(snap.raw, body);
  });

  test("non-integer version coerces to 0; ok derives from body.ok !== false", () => {
    assert.equal(toOpaqueSnapshot({}, "x").snapshotVersion, 0);
    assert.equal(toOpaqueSnapshot({ ok: false }, 1).ok, false);
    assert.equal(toOpaqueSnapshot({}, 1).ok, true);
  });
});

describe("vcsAccountForToken", () => {
  function fakeStore(links = {}, accounts = {}) {
    return {
      allTwitchLinks: () => links,
      getVcsAccount: (t) => accounts[t] || null,
    };
  }

  test("anonymous token (no link) → null, unverified pointer", () => {
    const acct = vcsAccountForToken(fakeStore(), "sig_x");
    assert.deepEqual(acct, {
      vcsAccountId: null,
      twitchLogin: null,
      snapshotVersion: 0,
      identitySource: "anonymous",
      verified: false,
    });
  });

  test("twitch-bound token resolves via reverse scan and derives the id", () => {
    const acct = vcsAccountForToken(fakeStore({ pagewarden: "sig_x" }), "sig_x");
    assert.equal(acct.verified, true);
    assert.equal(acct.identitySource, "twitch");
    assert.equal(acct.twitchLogin, "pagewarden");
    assert.equal(acct.vcsAccountId, deriveVcsAccountId("pagewarden"));
  });

  test("knownLogin short-circuits the reverse scan", () => {
    let scanned = false;
    const store = {
      allTwitchLinks: () => {
        scanned = true;
        return {};
      },
      getVcsAccount: () => null,
    };
    const acct = vcsAccountForToken(store, "sig_x", "PageWarden");
    assert.equal(scanned, false, "must not scan when the login is known");
    assert.equal(acct.vcsAccountId, deriveVcsAccountId("pagewarden"));
  });

  test("an ambiguous token (two logins) resolves to anonymous, not a guess", () => {
    const acct = vcsAccountForToken(fakeStore({ page: "sig_shared", warden: "sig_shared" }), "sig_shared");
    assert.equal(acct.verified, false);
    assert.equal(acct.vcsAccountId, null);
    assert.equal(acct.identitySource, "anonymous");
  });

  test("carries an existing persisted snapshotVersion", () => {
    const acct = vcsAccountForToken(
      fakeStore({ page: "sig_x" }, { sig_x: { snapshotVersion: 9 } }),
      "sig_x",
    );
    assert.equal(acct.snapshotVersion, 9);
  });
});

describe("bridge HMAC auth", () => {
  test("headers sign timestamp:<unix> and honour the ±30s replay window", () => {
    const key = "test-key";
    const h = buildBridgeAuthHeaders(key, 1_700_000_000_000);
    assert.equal(h["X-Vcs-Timestamp"], "1700000000");
    assert.equal(
      h["X-Vcs-Signature"],
      createHmac("sha256", key).update("timestamp:1700000000").digest("hex"),
    );
    assert.deepEqual(buildBridgeAuthHeaders("", 1), {}, "no key → no headers");
    assert.equal(isFreshBridgeTimestamp(1_700_000_000, 1_700_000_030_000), true);
    assert.equal(isFreshBridgeTimestamp(1_700_000_000, 1_700_000_031_000), false);
  });
});

describe("VcsClient (fixture-driven; real backend is private)", () => {
  function fakeFetch(routes) {
    return async (url) => {
      const path = new URL(url).pathname;
      const r = routes[path] || { status: 404, body: {} };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status || 200 });
    };
  }

  test("whoami derives the id from the response login, never a posted id", async () => {
    const client = new VcsClient({
      sessionCookie: "session_id=abc",
      fetchImpl: fakeFetch({
        "/api/v1/vcs/whoami": { body: { ok: true, login: "PageWarden", vcsAccountId: "vcs_FORGED" } },
      }),
    });
    const who = await client.whoami();
    assert.equal(who.ok, true);
    assert.equal(who.login, "pagewarden");
    assert.equal(who.vcsAccountId, deriveVcsAccountId("pagewarden"));
    assert.notEqual(who.vcsAccountId, "vcs_FORGED");
  });

  test("whoami 401 reports unauthenticated without inventing an account", async () => {
    const client = new VcsClient({
      fetchImpl: fakeFetch({ "/api/v1/vcs/whoami": { status: 401, body: { ok: false } } }),
    });
    const who = await client.whoami();
    assert.equal(who.ok, false);
    assert.equal(who.vcsAccountId, undefined);
  });

  test("me wraps the loadout as an opaque snapshot", async () => {
    const body = { ok: true, loadout: { cloak: "ash" } };
    const client = new VcsClient({
      sessionCookie: "session_id=abc",
      fetchImpl: fakeFetch({ "/api/v1/vcs/me": { body } }),
    });
    const res = await client.me(4);
    assert.equal(res.snapshot.schema, "vcs.snapshot.opaque.v1");
    assert.equal(res.snapshot.snapshotVersion, 5);
    assert.deepEqual(res.snapshot.raw, body);
  });
});

describe("store persistence — pointers only, churn-guarded", () => {
  let store;
  let freshWorld;
  let dir;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "mmo-vcs-"));
    process.env.MMO_DATA_DIR = dir;
    store = await import("../../server/store.js");
    ({ freshWorld } = await import("../../server/world-tick.js"));
    store.initStore?.();
    store.initWorldState(() => freshWorld());
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MMO_DATA_DIR;
  });

  test("upsert stores exactly the 5 pointer keys — no durable account dup", () => {
    const pointer = vcsAccountForToken({ allTwitchLinks: () => ({ page: "sig_p" }) }, "sig_p");
    const stored = store.upsertVcsAccount("sig_p", { ...pointer, loadout: { a: 1 }, profile: { b: 2 } });
    assert.deepEqual(
      Object.keys(stored).sort(),
      ["identitySource", "snapshotVersion", "twitchLogin", "vcsAccountId", "verified"],
      "must persist pointers only — no loadout/profile",
    );
    assert.equal(store.getVcsAccount("sig_p").vcsAccountId, pointer.vcsAccountId);
  });

  test("an unchanged upsert returns the same reference (churn guard held)", () => {
    const pointer = vcsAccountForToken({ allTwitchLinks: () => ({ page: "sig_p" }) }, "sig_p");
    const first = store.upsertVcsAccount("sig_p", pointer);
    const second = store.upsertVcsAccount("sig_p", pointer);
    assert.equal(first, second, "no-op upsert must not rewrite the pointer (no world.json churn)");
  });
});
