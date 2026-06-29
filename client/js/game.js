// SIGMA ABYSS — game orchestrator.
//
// Owns the live character, the canvas, the render loop, the real-time
// delve tick, every player action handler, and autosave. The shared
// sim modules do the rules; this wires them to the renderers, the HUD,
// audio, and the network.

import {
  DANGER_MAX,
  DANGER_PER_DEPTH,
  DELVE_TICK_MS,
  DEPTH_MAX,
  INVENTORY_MAX,
  POSTURES,
  POTION_COST,
  POTION_HEAL_FRAC,
  POTION_MAX,
  RARITY_RANK,
  STAT_KEYS,
  VH,
  VW,
} from "/shared/constants.js";
import {
  bankAtTown,
  delveTick,
  deployToZone,
  resolveDeath,
  retreatToTown,
} from "/shared/progression.js";
import { derive, distributeByPreset, spentPoints } from "/shared/stats.js";
import { recommendedZone } from "/shared/zones.js";
import { isMuted, setMuted, sfx, toggleMuted } from "./audio.js";
import * as barks from "./barks.js";
import * as combatView from "./combat-view.js";
import { music } from "./fx-music.js";
import * as legendaryGet from "./legendary-get.js";
import * as net from "./net.js";
import * as save from "./save.js";
import * as ui from "./ui.js";
import * as world from "./world.js";

let character = null;
let token = null;
let state = "boot"; // boot | town | delve | combat | death
let canvas = null;
let ctx = null;
let lastFrame = 0;
let lastTick = 0;
let lastLocalSave = 0;
let lastNetSave = 0;
let overlayMode = false; // ?overlay=1 — strips UI chrome + makes canvas transparent

// ── real-time agency (set while a combat playback is on screen) ────────
// The deterministic encounter is already resolved before its animation plays,
// so a panic action pressed mid-fight can't change the locked outcome. Instead
// we QUEUE it and apply it the instant the playback finishes — post-resolution,
// in this file only, never inside the sim. Offline progression never sets these
// (it has no player input), so offline↔live determinism is untouched.
let pendingPanicHeal = 0; // # of panic potions slammed during the current fight
let pendingRecall = false; // player hit EMERGENCY RECALL during the current fight
let userMuteChoice = false; // player has explicitly toggled SFX → stop auto-unmute

export function setOverlayMode(on) {
  overlayMode = !!on;
  world.setOverlayMode(overlayMode);
}

// Stream-overlay flow: skip the town/howto UX and put the sigma straight
// into the toughest unlocked zone so chatters watching the stream
// immediately see monsters chasing it.
export function autoDeployForOverlay() {
  if (!character) return;
  if (state !== "town") return;
  const zone = recommendedZone(character);
  if (!zone) return;
  const r = deployToZone(character, zone.id);
  if (!r.ok) return;
  character.posture = "delve";
  world.setCharacter(character);
  state = "delve";
  music.setPhase("delve");
  lastTick = performance.now();
  saveNow();
}

// ── boot ──────────────────────────────────────────────────────────────
export function boot(char, tok) {
  character = char;
  token = tok;
  canvas = document.getElementById("game-canvas");
  ctx = canvas.getContext("2d");
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);
  world.setCharacter(character);
  barks.setVoice(character.seed); // each sigma gets its own bark voice pitch
  state = character.run && character.run.zone !== "town" ? "delve" : "town";
  lastTick = performance.now();
  lastFrame = performance.now();
  ui.update(character, state);
  music.setPhase(state === "delve" ? "delve" : "town");
  armAutoUnmute();
  requestAnimationFrame(loop);
}

// Browsers block audio until a user gesture, and "players need to HEAR it".
// Outside OBS-overlay mode (where the streamer opts in deliberately), flip SFX
// on at the player's first click/keypress — unless they've already chosen to
// mute. Overlay mode stays muted by default so it never doubles the stream mix.
function armAutoUnmute() {
  if (overlayMode) return;
  const arm = () => {
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
    if (userMuteChoice || !isMuted()) return;
    setMuted(false);
    music.refresh();
    ui.update(character, state);
  };
  window.addEventListener("pointerdown", arm, { once: false });
  window.addEventListener("keydown", arm, { once: false });
}

export function saveNow() {
  if (!character) return;
  character.lastSeen = Date.now();
  save.saveLocal(token, character);
  net.saveCharacter(character);
  lastLocalSave = performance.now();
  lastNetSave = performance.now();
}

function sizeCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  // Letterbox the 1920x1080 virtual space into the viewport.
  const scale = Math.min(w / VW, h / VH);
  const ox = (w - VW * scale) / 2;
  const oy = (h - VH * scale) / 2;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
}

function clearFrame() {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (overlayMode) {
    // Transparent OBS browser source — DON'T fill black, just clear.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

// ── main loop ─────────────────────────────────────────────────────────
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(now - (lastFrame || now), 80);
  lastFrame = now;

  // logic
  if (combatView.isPlaying()) {
    // combat-view owns the screen; no world stepping, no ticks.
  } else if (state === "delve") {
    world.step(dt, "delve", now);
    if (now - lastTick >= DELVE_TICK_MS) {
      lastTick = now;
      doDelveTick();
    }
  } else if (state === "town") {
    world.step(dt, "town", now);
  }

  // render
  clearFrame();
  if (combatView.isPlaying()) {
    combatView.draw(ctx, now);
  } else if (state === "town") {
    world.drawTown(ctx, character, now);
  } else if (state === "delve") {
    world.drawDelve(ctx, character, now);
  } else {
    world.drawVoid(ctx, now);
  }

  // Legendary "item get" flourish — drawn on top of whatever scene is showing.
  legendaryGet.draw(ctx, now, VW, VH, overlayMode);

  // autosave
  if (now - lastLocalSave > 4000) {
    lastLocalSave = now;
    save.saveLocal(token, character);
  }
  if (now - lastNetSave > 6000) {
    lastNetSave = now;
    character.lastSeen = Date.now();
    net.saveCharacter(character);
  }
}

// ── the delve tick ────────────────────────────────────────────────────
function doDelveTick() {
  // fresh encounter → clear any agency queued against the previous one
  pendingPanicHeal = 0;
  pendingRecall = false;
  const hpBefore = character.run.hp;
  const maxHpBefore = derive(character.run, character).maxHp;
  const out = delveTick(character);
  if (out.type === "idle") {
    state = "town";
    ui.update(character, state);
    return;
  }

  const finish = () => applyTickOutcome(out);
  if (out.result?.events?.length) {
    state = "combat";
    ui.enterCombat(character); // surface the panic bar over the fight (no HUD spoiler)
    combatView.play({
      enemies: out.enemies,
      events: out.result.events,
      fighterStartHp: hpBefore,
      fighterMaxHp: maxHpBefore,
      character,
      isFaint: out.reason === "faint",
      onDone: finish,
    });
  } else {
    finish();
  }
}

function applyTickOutcome(out) {
  const run = character.run;
  // ── consume real-time agency queued during the just-finished fight ──
  const panicHeals = pendingPanicHeal;
  const recall = pendingRecall;
  pendingPanicHeal = 0;
  pendingRecall = false;

  // loot feedback
  if (out.loot?.length) {
    for (const it of out.loot) {
      ui.lootToast(it);
      sfx.loot(RARITY_RANK[it.rarity] || 0);
      if ((RARITY_RANK[it.rarity] || 0) >= RARITY_RANK.legendary) {
        ui.toast(`${it.rarity.toUpperCase()} DROP`, true);
        barks.say("loot", { force: true });
        net.postEvent({ kind: "legendary", name: character.name, detail: `pulled ${it.name}` });
        // Zelda-style "item get" flourish. delveTick auto-equips a legendary
        // weapon straight off the ground, so when this drop is now the held
        // weapon the banner reads NOW WIELDING and the hero hoists it overhead.
        const equipped = character.run?.gear?.weapon?.id === it.id;
        legendaryGet.trigger(it, {
          equipped,
          pet: {
            seed: character.seed,
            cosmetics: character.cosmetics || {},
            weapon: character.run?.gear?.weapon || null,
            _motion: { facing: 1, vx: 0, vz: 0 },
          },
        });
      }
    }
  }
  if (out.xpRes?.leveled) {
    sfx.levelUp();
    ui.toast(`LEVEL ${out.xpRes.newLevel}`, true);
    barks.say("levelUp", { force: true });
  }

  if (out.type === "death") {
    // EMERGENCY RECALL death-mercy. If the player hit RECALL during the fatal
    // fight AND still has an escape potion to burn, they're yanked out at a
    // sliver instead of dying. Tying cheat-death to a consumable keeps
    // permadeath honest (you die when out of supplies), and the AWAY sigma —
    // which never has input — never gets the mercy, so idle play keeps real
    // stakes. Pure post-resolution mutation; the sim already ran.
    if (recall && run && run.potions > 0) {
      run.potions -= 1;
      run.alive = true;
      const d = derive(run, character);
      run.hp = Math.max(1, Math.round(d.maxHp * 0.15));
      sfx.retreat();
      ui.toast("EMERGENCY RECALL — yanked from the abyss!", true);
      barks.say("recall", { force: true, life: 1900 });
      net.postEvent({
        kind: "milestone",
        name: character.name,
        detail: "cheated death with an emergency recall",
      });
      retreatToTown(character);
      toTown(null);
      return;
    }
    handleDeath(out);
    return;
  }

  if (out.type === "boss_clear") {
    sfx.bank();
    ui.toast("ZONE BOSS DOWN", true);
    barks.say("victory", { force: true, life: 1900 });
    net.postEvent({ kind: "boss", name: character.name, detail: `cleared the ${out.zone.name}` });
    retreatToTown(character);
    const banked = bankAtTown(character);
    toTown(banked);
    return;
  }
  if (out.type === "retreat") {
    if (out.reason === "faint") {
      sfx.retreat();
      barks.say("death", { force: true, life: 2200 });
      const lostId = out.faint?.lost;
      ui.toast(`FAINTED${lostId ? ` — ${lostId} lost` : ""}`, true);
      net.postEvent({
        kind: "milestone",
        name: character.name,
        detail: `fainted and lost ${lostId ?? "their active weapon"}`,
      });
    } else {
      sfx.retreat();
      barks.say(out.reason === "fled" ? "flee" : "recall", { force: true });
    }
    retreatToTown(character);
    toTown(null);
    return;
  }

  // 'continue' — survived; the sigma would push deeper…
  if (recall) {
    // …but the player pulled EMERGENCY RECALL: bail to town, haul intact.
    sfx.retreat();
    ui.toast("EMERGENCY RECALL — back in town, haul secured", true);
    barks.say("recall", { force: true });
    retreatToTown(character);
    toTown(null);
    return;
  }
  // Apply any panic potions slammed mid-fight so the NEXT encounter doesn't
  // open with the sigma still gutted. (The potions were already spent at
  // press time; this just lands the heal.)
  if (panicHeals > 0 && run) {
    const d = derive(run, character);
    run.hp = Math.min(d.maxHp, run.hp + Math.round(d.maxHp * POTION_HEAL_FRAC) * panicHeals);
  }
  state = "delve";
  music.setPhase("delve");
  lastTick = performance.now();
  ui.update(character, state);
  saveNow();
}

function handleDeath(out) {
  sfx.death();
  const res = resolveDeath(character, out);
  net.postEvent(res.feedEntry);
  if (res.summary.unlocks?.length) {
    sfx.ascend();
    net.postEvent({
      kind: "ascend",
      name: character.name,
      detail: `ascended — earned ${res.summary.unlocks.map((u) => u.value).join(", ")}`,
    });
  }
  world.setCharacter(character); // fresh run, same sigma
  state = "death";
  music.setPhase("town");
  music.setCriticalHp(false);
  ui.showDeath(res.summary);
  ui.update(character, state);
  saveNow();
}

function toTown(banked) {
  world.setCharacter(character);
  state = "town";
  music.setPhase("town");
  music.setCriticalHp(false);
  if (banked?.itemsSold) {
    ui.toast(`banked ${banked.itemsSold} items → ${banked.gold}g`);
  }
  ui.update(character, state);
  saveNow();
}

// ── Twitch redemption effects (driven by net.onTwitchAction) ──────────
// Each kind is the minimum viable in-game reaction so the chatter sees
// SOMETHING when they redeem. Polish (full elite encounter injection,
// camera-zoom for featured, etc.) can grow incrementally without
// changing the wire contract.
export function applyTwitchAction(kind, params) {
  if (!character) return;
  const run = character.run;

  if (kind === "delve") {
    // Force-deploy if in town. If already in a delve, push deeper so
    // the redemption still produces a visible kick.
    if (state === "town" && run && run.zone) {
      const r = deployToZone(character, run.zone);
      if (r.ok) {
        character.posture = "delve";
        sfx.deploy();
        world.setCharacter(character);
        state = "delve";
        music.setPhase("delve");
        lastTick = performance.now();
        ui.toast("TWITCH DEPLOY — forced into the abyss", true);
        ui.update(character, state);
        saveNow();
        return;
      }
    }
    if (state === "delve" && run) {
      run.depth = Math.min(DEPTH_MAX, run.depth + 1);
      run.danger = Math.min(DANGER_MAX, run.danger + DANGER_PER_DEPTH);
      lastTick = performance.now() - DELVE_TICK_MS;
      ui.toast("TWITCH DEPLOY — pushed deeper", true);
    }
    return;
  }

  if (kind === "fight") {
    // Drag the next encounter forward; mark next tick as elite via a
    // run-level flag the combat-view + delveTick already check (defaults
    // off so the flag is harmless if the sim doesn't read it yet).
    if (state === "delve" && run) {
      run._twitchEliteNext = true;
      run.danger = Math.min(DANGER_MAX, run.danger + DANGER_PER_DEPTH * 2);
      lastTick = performance.now() - DELVE_TICK_MS;
      ui.toast("TWITCH ELITE INCOMING", true);
    }
    return;
  }

  if (kind === "resurrect") {
    // Top off HP unconditionally; if the run is gone (post-permadeath
    // wipe), the next deploy will mint a fresh one. Mirrors the in-game
    // potion path so we don't re-derive ad-hoc.
    if (run) {
      const d = derive(run, character);
      run.hp = d.maxHp;
      run.potions = Math.min(POTION_MAX, run.potions + 2);
      ui.toast("TWITCH RESURRECT — back at full HP", true);
      ui.update(character, state);
      saveNow();
    }
    return;
  }

  if (kind === "featured") {
    const durMs = Number(params?.duration_ms) || 30_000;
    character.featuredUntil = Date.now() + durMs;
    ui.toast("TWITCH SPOTLIGHT — featured!", true);
    return;
  }
}

// ── player action handlers (wired into ui.init) ───────────────────────
export const handlers = {
  isMuted: () => isMuted(),

  onToggleMute: () => {
    userMuteChoice = true; // explicit choice — don't auto-flip it back
    toggleMuted();
    music.refresh();
    ui.update(character, state);
  },

  onDeploy: (zoneId) => {
    if (state !== "town") return;
    const r = deployToZone(character, zoneId);
    if (!r.ok) return;
    character.posture = "delve"; // deploying ends a rest
    sfx.deploy();
    world.setCharacter(character);
    state = "delve";
    music.setPhase("delve");
    lastTick = performance.now();
    barks.say("deploy", { force: true });
    ui.update(character, state);
    saveNow();
  },

  // ── real-time agency: PANIC POTION + EMERGENCY RECALL ────────────────
  // Both work during the delve walk AND mid-fight. Mid-fight they can't touch
  // the already-resolved encounter, so they queue (pendingPanicHeal /
  // pendingRecall) and apply when the playback ends — with instant audio/visual
  // feedback now so it FEELS real-time. Out of combat they act immediately.
  onPanic: () => {
    if (!character) return;
    const run = character.run;
    if (!run) return;
    const d = derive(run, character);
    if (combatView.isPlaying()) {
      if (run.potions > 0) {
        run.potions -= 1; // spent now; the heal lands at fight-end
        pendingPanicHeal += 1;
        combatView.injectPanic("potion");
        ui.refreshPanic(character); // update the potion count, not the whole HUD
      } else {
        ui.toast("no potions!");
      }
      return;
    }
    if (state === "delve") {
      if (run.potions <= 0 || run.hp >= d.maxHp) return;
      run.potions -= 1;
      run.hp = Math.min(d.maxHp, run.hp + Math.round(d.maxHp * POTION_HEAL_FRAC));
      sfx.ui();
      barks.say("potion", { force: true });
      ui.update(character, state);
    }
  },

  onRecall: () => {
    if (!character) return;
    if (combatView.isPlaying()) {
      pendingRecall = true;
      combatView.injectPanic("recall");
      ui.toast("EMERGENCY RECALL — bailing the moment this ends!");
      return;
    }
    if (state === "delve") {
      sfx.retreat();
      barks.say("recall", { force: true });
      retreatToTown(character);
      toTown(null);
    }
  },

  onRetreat: () => {
    if (state !== "delve") return;
    sfx.retreat();
    retreatToTown(character);
    toTown(null);
  },

  onSetPosture: (posture) => {
    if (state !== "town") return;
    if (!POSTURES.includes(posture) || character.posture === posture) return;
    character.posture = posture;
    world.setCharacter(character); // refresh the sleeping flag
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onPotion: () => {
    if (state !== "delve") return;
    const run = character.run;
    const d = derive(run, character);
    if (run.potions <= 0 || run.hp >= d.maxHp) return;
    run.potions -= 1;
    run.hp = Math.min(d.maxHp, run.hp + Math.round(d.maxHp * POTION_HEAL_FRAC));
    sfx.ui();
    ui.update(character, state);
  },

  onPush: () => {
    if (state !== "delve") return;
    const run = character.run;
    run.depth = Math.min(DEPTH_MAX, run.depth + 2);
    run.danger = Math.min(DANGER_MAX, run.danger + DANGER_PER_DEPTH * 2);
    sfx.ui();
    lastTick = performance.now() - DELVE_TICK_MS; // bring the next encounter forward
    ui.update(character, state);
  },

  onEquip: (itemId) => {
    if (state !== "town") return;
    const run = character.run;
    const idx = run.inventory.findIndex((it) => it.id === itemId);
    if (idx < 0) return;
    const item = run.inventory.splice(idx, 1)[0];
    const old = run.gear[item.slot];
    run.gear[item.slot] = item;
    if (old) run.inventory.push(old);
    const mh = derive(run, character).maxHp;
    if (run.hp > mh) run.hp = mh;
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onUnequip: (slot) => {
    if (state !== "town") return;
    const run = character.run;
    const it = run.gear[slot];
    if (!it || run.inventory.length >= INVENTORY_MAX) return;
    run.gear[slot] = null;
    run.inventory.push(it);
    const mh = derive(run, character).maxHp;
    if (run.hp > mh) run.hp = mh;
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onSell: (itemId) => {
    if (state !== "town") return;
    const run = character.run;
    const idx = run.inventory.findIndex((it) => it.id === itemId);
    if (idx < 0) return;
    const item = run.inventory.splice(idx, 1)[0];
    character.gold += item.value || 0;
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onBankAll: () => {
    if (state !== "town") return;
    const r = bankAtTown(character);
    if (r.unlocks?.length) sfx.ascend();
    else sfx.bank();
    if (r.unlocks?.length) {
      ui.toast(`ASCENDED — ${r.unlocks.map((u) => u.value).join(", ")}`, true);
    }
    ui.update(character, state);
    saveNow();
  },

  onBuyPotion: () => {
    if (state !== "town") return;
    const run = character.run;
    if (character.gold < POTION_COST || run.potions >= POTION_MAX) return;
    character.gold -= POTION_COST;
    run.potions += 1;
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onAllocate: (statKey) => {
    if (state !== "town") return;
    const run = character.run;
    if (run.statPoints <= 0 || !STAT_KEYS.includes(statKey)) return;
    run.stats[statKey] = (run.stats[statKey] || 0) + 1;
    run.statPoints -= 1;
    run.hp = derive(run, character).maxHp; // resting in town — top off
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onRespec: (presetKey) => {
    if (state !== "town") return;
    const run = character.run;
    const total = spentPoints(run.stats) + run.statPoints;
    run.stats = distributeByPreset(presetKey, total);
    run.statPoints = 0;
    run.hp = derive(run, character).maxHp;
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onAi: (partial) => {
    Object.assign(character.run.ai, partial);
    ui.update(character, state);
    saveNow();
  },

  onCosmetic: (slot, value) => {
    if (value == null) delete character.cosmetics[slot];
    else character.cosmetics[slot] = value;
    world.setCharacter(character);
    sfx.ui();
    ui.update(character, state);
    saveNow();
  },

  onRiseAgain: () => {
    world.setCharacter(character);
    state = "town";
    ui.update(character, state);
    saveNow();
  },
};
