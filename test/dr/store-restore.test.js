// SIGMA ABYSS — disaster-recovery test for the JSON store.
//
// DR contract: if the server crashes mid-flight, the next initStore() must
// recover every flushed-to-disk record without data loss. This test exercises
// the round-trip — write via the in-memory store, flush, read the JSON file
// directly to verify shape, then re-import the module and confirm initStore()
// reloads the same data.
//
// The store's DATA_DIR is hardcoded to `<root>/data/`, so we use a unique
// `sig_dr_<rand>` token + register an `after()` hook that removes the test
// player from every artifact even on assertion failure. The live server (if
// running) only touches the data files via the same store API — concurrent
// writes will preserve our test token until the cleanup hook removes it.
//
// Run: node --test test/dr/store-restore.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../../server/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const FEED_FILE = path.join(DATA_DIR, "feed.json");

// Real anon-token shape from server/realtime.js: "sig_" + 24 hex chars.
function mintTestToken() {
  return `sig_${crypto.randomBytes(12).toString("hex")}`;
}

// Track every token + feed event this test writes so the cleanup hook can
// scrub them whether the test passed, failed, or hung.
const dirtyTokens = new Set();
const dirtyFeedTags = new Set();

after(() => {
  // Players file
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
      let mutated = false;
      for (const tok of dirtyTokens) {
        if (tok in data) {
          delete data[tok];
          mutated = true;
        }
      }
      if (mutated) fs.writeFileSync(PLAYERS_FILE, JSON.stringify(data));
    }
  } catch {
    /* ok */
  }
  // Feed file
  try {
    if (fs.existsSync(FEED_FILE)) {
      const feed = JSON.parse(fs.readFileSync(FEED_FILE, "utf8"));
      if (Array.isArray(feed)) {
        const filtered = feed.filter(
          (e) => !(e && typeof e.tag === "string" && dirtyFeedTags.has(e.tag)),
        );
        if (filtered.length !== feed.length) {
          fs.writeFileSync(FEED_FILE, JSON.stringify(filtered));
        }
      }
    }
  } catch {
    /* ok */
  }
});

describe("store DR — flushed data persists in the on-disk JSON shape", () => {
  test("putPlayer + flush writes the documented players.json shape", () => {
    store.initStore();
    const token = mintTestToken();
    dirtyTokens.add(token);
    const character = {
      name: "DR Probe",
      gold: 12345,
      lastSeen: Date.now(),
      run: { level: 7, hp: 100, zone: "town" },
    };
    store.putPlayer(token, character);
    store.flush();

    // Read the file directly — no store helpers, just raw fs.
    assert.ok(fs.existsSync(PLAYERS_FILE), "players.json should exist after flush");
    const onDisk = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
    assert.ok(token in onDisk, `players.json should contain test token after flush`);
    assert.equal(onDisk[token].character.name, "DR Probe");
    assert.equal(onDisk[token].character.gold, 12345);
    assert.equal(onDisk[token].character.run.level, 7);
    assert.ok(typeof onDisk[token].updatedAt === "number", "updatedAt should be set");
  });

  test("pushFeed + flush writes the documented feed.json shape", () => {
    store.initStore();
    const tag = `dr-test-${crypto.randomBytes(4).toString("hex")}`;
    dirtyFeedTags.add(tag);
    store.pushFeed({ kind: "milestone", tag, message: "DR persistence probe" });
    store.flush();

    assert.ok(fs.existsSync(FEED_FILE), "feed.json should exist after flush");
    const feed = JSON.parse(fs.readFileSync(FEED_FILE, "utf8"));
    assert.ok(Array.isArray(feed), "feed.json is an array");
    const entry = feed.find((e) => e && e.tag === tag);
    assert.ok(entry, "test feed entry should land on disk");
    assert.equal(entry.kind, "milestone");
    assert.equal(entry.message, "DR persistence probe");
    assert.ok(typeof entry.at === "number", "pushFeed should stamp at:");
  });
});

describe("store DR — restart recovery (initStore reloads from disk)", () => {
  test("initStore() rehydrates the in-memory map from players.json", () => {
    // First "process": write + flush via the real store. Putting + flushing
    // proves the file is on disk; subsequent initStore() should reload it.
    const token = mintTestToken();
    dirtyTokens.add(token);
    store.initStore();
    store.putPlayer(token, { name: "Restart Probe", gold: 42 });
    store.flush();

    // Simulate "process restart" by re-calling initStore(). The module's
    // singleton Map is reset and re-read from disk. (We cannot re-import the
    // module to get a fresh isolate, but initStore() re-assigns the Map from
    // the file — same effective recovery path.)
    store.initStore();
    const restored = store.getPlayer(token);
    assert.ok(restored, "player should be present after re-initStore()");
    assert.equal(restored.character.name, "Restart Probe");
    assert.equal(restored.character.gold, 42);
  });

  test("playerCount() reflects loaded data after re-init", () => {
    store.initStore();
    const beforeCount = store.playerCount();
    const token = mintTestToken();
    dirtyTokens.add(token);
    store.putPlayer(token, { name: "Count Probe" });
    store.flush();
    store.initStore();
    assert.equal(
      store.playerCount(),
      beforeCount + 1,
      "playerCount should grow by 1 after putPlayer + flush + restart",
    );
  });
});

describe("store DR — atomic write integrity (no .tmp leftovers)", () => {
  test("a successful flush leaves no .tmp files behind", () => {
    store.initStore();
    const token = mintTestToken();
    dirtyTokens.add(token);
    store.putPlayer(token, { name: "Atomic Probe" });
    store.flush();

    const tmpFiles = fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".tmp") && (f.includes("players") || f.includes("feed")));
    assert.deepEqual(tmpFiles, [], `unexpected .tmp leftovers: ${tmpFiles.join(", ")}`);
  });
});
