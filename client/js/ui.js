// SIGMA ABYSS — DOM HUD + panels.
//
// Builds everything inside #ui-root once, then update() refreshes it
// from character state. The canvas behind shows the world; this is
// every readout, panel and button on top of it. game.js owns game
// logic and hands ui.js a `handlers` bag of callbacks.

import { backstoryBio } from "/shared/backstory.js";
import {
  AI_BOUNDS,
  AI_TARGET_LABEL,
  AI_TARGET_PRIORITY,
  BUILD_PRESETS,
  DANGER_BOSS_AT,
  DANGER_ELITE_AT,
  GEAR_SLOT_LABEL,
  GEAR_SLOTS,
  POTION_COST,
  POTION_MAX,
  RARITY_COLOR,
  RARITY_LABEL,
  STAT_BLURB,
  STAT_KEYS,
  STAT_LABEL,
} from "/shared/constants.js";
import { diseaseList } from "/shared/diseases.js";
import { injuryList } from "/shared/health.js";
import { inspirationById } from "/shared/inspirations.js";
import { affixText, itemPower } from "/shared/loot.js";
import { breakById } from "/shared/mental-breaks.js";
import { MOOD_BAND_COLOR, MOOD_BAND_LABEL, moodBand } from "/shared/mood.js";
import { xpForLevel } from "/shared/progression.js";
import { passionMul, SKILLS, xpForSkillLevel } from "/shared/skills.js";
import { derive } from "/shared/stats.js";
import { STORYTELLERS } from "/shared/storyteller.js";
import { traitById } from "/shared/traits.js";
import { ZONES, zoneById } from "/shared/zones.js";

// ── tiny DOM builder ──────────────────────────────────────────────────
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style") Object.assign(e.style, v);
    else if (typeof v === "boolean")
      e[k] = v; // disabled/checked → property, never a stray attribute
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}
const pct = (f) => `${Math.round(f * 100)}%`;
const num = (n) => Math.round(n).toLocaleString();
const clear = (n) => {
  while (n.firstChild) n.removeChild(n.firstChild);
};

let H = {}; // handlers from game.js
const R = {}; // cached element references
let townTab = "deploy";
let lootToastEls = [];

// ════════════════════════════════════════════════════════════════════
//  BUILD
// ════════════════════════════════════════════════════════════════════
export function init(handlers) {
  H = handlers || {};
  const root = document.getElementById("ui-root");
  clear(root);
  root.appendChild(buildHud());
  root.appendChild(buildFeed());
  root.appendChild(buildLeaderboard());
  root.appendChild(buildTownPanel());
  root.appendChild(buildDelveOverlay());
  root.appendChild(buildPanicBar());
  root.appendChild(buildDeathScreen());
  root.appendChild(buildModal("offline-modal", "WHILE YOU WERE GONE"));
  root.appendChild(buildModal("howto-modal", "HOW TO PLAY — SIGMA ABYSS"));
  root.appendChild(el("div", { id: "center-toasts", class: "center-toasts" }));
  root.appendChild(el("div", { id: "conn-dot", class: "conn-dot", text: "offline" }));
  R.centerToasts = document.getElementById("center-toasts");
  R.connDot = document.getElementById("conn-dot");
  window.addEventListener("keydown", onHotkey);
}

// Keyboard agency — works during the delve walk AND mid-fight. The handlers
// themselves decide what each key means by state, so this just routes them.
function onHotkey(e) {
  if (e.repeat) return;
  const tag = e.target?.tagName || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
  if (document.querySelector(".modal:not(.hidden)")) return; // a panel is open
  const k = e.key;
  if (k === "p" || k === "P" || k === " ") {
    e.preventDefault();
    H.onPanic?.();
  } else if (k === "r" || k === "R" || k === "Escape") {
    H.onRecall?.();
  } else if (k === "m" || k === "M") {
    H.onToggleMute?.();
  }
}

function buildHud() {
  const bar = (cls, fillId, labelId) =>
    el("div", { class: `bar ${cls}` }, [el("span", { id: fillId }), el("label", { id: labelId })]);
  const hud = el("header", { id: "hud", class: "hud hidden" }, [
    el("div", { class: "hud-id" }, [
      el("div", { id: "hud-name", text: "SIGMA" }),
      el("div", { id: "hud-title", class: "hud-title" }),
    ]),
    el("div", { class: "hud-bars" }, [
      bar("hp", "hp-fill", "hp-label"),
      bar("xp", "xp-fill", "xp-label"),
    ]),
    el("div", { class: "hud-meters" }, [
      el("div", { class: "meter danger" }, [
        el("span", { id: "danger-fill" }),
        el("label", { text: "DANGER" }),
      ]),
      el("div", { class: "label", id: "streak-line", style: { marginTop: ".3em" } }),
    ]),
    el("div", { class: "hud-stats" }, [
      el("span", { id: "hud-level" }),
      el("span", { id: "hud-zone" }),
      el("span", { id: "hud-gold" }),
      el("span", { id: "hud-prestige" }),
      el("span", { id: "hud-power" }),
      el("span", { id: "hud-kills" }),
    ]),
    el("div", { class: "hud-online" }, [
      el("span", { id: "hud-players", text: "1 online" }),
      el("div", { class: "row" }, [
        el("button", { class: "mini", text: "? HELP", onClick: () => showHowTo() }),
        el("button", {
          class: "mini",
          id: "btn-mute",
          text: "SFX OFF",
          onClick: () => H.onToggleMute?.(),
        }),
      ]),
    ]),
  ]);
  Object.assign(R, {
    hud,
    hudName: hud.querySelector("#hud-name"),
    hudTitle: hud.querySelector("#hud-title"),
    hpFill: hud.querySelector("#hp-fill"),
    hpLabel: hud.querySelector("#hp-label"),
    xpFill: hud.querySelector("#xp-fill"),
    xpLabel: hud.querySelector("#xp-label"),
    dangerFill: hud.querySelector("#danger-fill"),
    streakLine: hud.querySelector("#streak-line"),
    hudLevel: hud.querySelector("#hud-level"),
    hudZone: hud.querySelector("#hud-zone"),
    hudGold: hud.querySelector("#hud-gold"),
    hudPrestige: hud.querySelector("#hud-prestige"),
    hudPower: hud.querySelector("#hud-power"),
    hudKills: hud.querySelector("#hud-kills"),
    hudPlayers: hud.querySelector("#hud-players"),
    btnMute: hud.querySelector("#btn-mute"),
  });
  return hud;
}

function buildFeed() {
  const track = el("div", { id: "feed-track" });
  const tick = el("div", { id: "feed-ticker", class: "feed-ticker hidden" }, [track]);
  R.feedTrack = track;
  R.feedTicker = tick;
  return tick;
}

function buildLeaderboard() {
  const list = el("div", { class: "lb-list", id: "lb-list" });
  const lb = el("aside", { id: "leaderboard", class: "leaderboard hidden" }, [
    el("h3", { text: "TOP SIGMAS — by prestige" }),
    list,
  ]);
  R.lbList = list;
  R.leaderboard = lb;
  return lb;
}

function buildTownPanel() {
  const tabs = el("div", { class: "town-tabs" });
  const TABS = [
    ["deploy", "Deploy"],
    ["character", "Character"],
    ["bio", "Bio"],
    ["mind", "Mind"],
    ["health", "Health"],
    ["gear", "Gear"],
    ["brain", "Brain"],
    ["drip", "Drip"],
  ];
  for (const [id, label] of TABS) {
    tabs.appendChild(
      el("button", {
        "data-tab": id,
        text: label,
        onClick: () => {
          townTab = id;
          if (R.character) renderTown(R.character);
        },
      }),
    );
  }
  const body = el("div", { class: "town-body", id: "town-body" });
  const panel = el("section", { id: "town-panel", class: "panel hidden" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { text: "IRONHOLLOW" }),
      el("span", { class: "label", id: "town-sub" }),
    ]),
    tabs,
    body,
  ]);
  R.townPanel = panel;
  R.townTabs = tabs;
  R.townBody = body;
  R.townSub = panel.querySelector("#town-sub");
  return panel;
}

function buildDelveOverlay() {
  const readout = el("div", { class: "delve-readout" }, [
    el("div", { class: "dr-zone", id: "dr-zone" }),
    el("div", { html: 'depth <b id="dr-depth">0</b>' }),
    el("div", { html: 'danger <b id="dr-danger">0%</b>' }),
    el("div", { html: 'kills <b id="dr-kills">0</b>' }),
    el("div", { html: 'haul <b id="dr-haul">0</b> items' }),
    el("div", { class: "delve-mind", id: "dr-mind" }),
  ]);
  // The safety levers (PANIC POTION / EMERGENCY RECALL) live in the always-on
  // panic bar now; the delve overlay keeps only PUSH DEEPER — the risk lever.
  const controls = el("div", { class: "delve-controls" }, [
    el("button", { id: "btn-push", text: "PUSH DEEPER", onClick: () => H.onPush?.() }),
  ]);
  const toasts = el("div", { class: "loot-toasts", id: "loot-toasts" });
  const ov = el("section", { id: "delve-overlay", class: "hidden" }, [readout, controls, toasts]);
  R.delveOverlay = ov;
  R.drZone = readout.querySelector("#dr-zone");
  R.drDepth = readout.querySelector("#dr-depth");
  R.drDanger = readout.querySelector("#dr-danger");
  R.drKills = readout.querySelector("#dr-kills");
  R.drHaul = readout.querySelector("#dr-haul");
  R.drMind = readout.querySelector("#dr-mind");
  R.btnPush = controls.querySelector("#btn-push");
  R.lootToasts = toasts;
  return ov;
}

// The always-on agency bar — visible during the delve walk AND on top of a
// fight (the delve overlay hides during combat, but THIS stays so the player
// can always save themselves). Big thumby buttons + low-HP pulse.
function buildPanicBar() {
  const bar = el("section", { id: "panic-bar", class: "panic-bar hidden" }, [
    el("button", {
      id: "btn-panic-potion",
      class: "panic-btn potion",
      text: "PANIC POTION",
      onClick: () => H.onPanic?.(),
    }),
    el("button", {
      id: "btn-panic-recall",
      class: "panic-btn recall",
      text: "EMERGENCY RECALL",
      onClick: () => H.onRecall?.(),
    }),
    el("div", {
      class: "panic-hint",
      html: "<kbd>P</kbd>/<kbd>Space</kbd> potion &nbsp; <kbd>R</kbd>/<kbd>Esc</kbd> recall",
    }),
  ]);
  R.panicBar = bar;
  R.btnPanicPotion = bar.querySelector("#btn-panic-potion");
  R.btnPanicRecall = bar.querySelector("#btn-panic-recall");
  return bar;
}

function renderPanicBar(character, hpFrac) {
  const run = character.run;
  R.btnPanicPotion.textContent = `PANIC POTION (${run.potions})`;
  R.btnPanicPotion.disabled = run.potions <= 0;
  // pulse red when HP is in the danger band so the player knows to react NOW
  R.panicBar.classList.toggle("danger-pulse", hpFrac <= 0.34);
}

function buildDeathScreen() {
  const box = el("section", { id: "death-screen", class: "hidden" }, [
    el("div", { class: "death-word", text: "YOU DIED" }),
    el("div", { class: "death-by", id: "death-by" }),
    el("div", { class: "death-stats", id: "death-stats" }),
    el("div", { class: "death-prestige", id: "death-prestige" }),
    el("div", { class: "death-lost", id: "death-lost" }),
    el("button", {
      class: "primary",
      id: "btn-rise",
      text: "RISE AGAIN",
      style: { marginTop: "1em", fontSize: "1.1em", padding: ".7em 2em" },
      onClick: () => H.onRiseAgain?.(),
    }),
  ]);
  R.deathScreen = box;
  R.deathBy = box.querySelector("#death-by");
  R.deathStats = box.querySelector("#death-stats");
  R.deathPrestige = box.querySelector("#death-prestige");
  R.deathLost = box.querySelector("#death-lost");
  return box;
}

function buildModal(id, title) {
  const body = el("div", { class: "panel-body", id: `${id}-body` });
  const modal = el("section", { id, class: "modal hidden" }, [
    el("div", { class: "modal-box" }, [
      el("div", { class: "panel-head" }, [
        el("h2", { text: title }),
        el("button", {
          class: "mini",
          text: "CLOSE",
          onClick: () => modal.classList.add("hidden"),
        }),
      ]),
      body,
    ]),
  ]);
  R[`${id}-body`] = body;
  R[id] = modal;
  return modal;
}

// ════════════════════════════════════════════════════════════════════
//  UPDATE
// ════════════════════════════════════════════════════════════════════
export function update(character, state) {
  if (!character) return;
  R.character = character;
  R.state = state;
  const run = character.run;
  const d = derive(run, character);

  // ── HUD ─────────────────────────────────────────────────────────────
  R.hud.classList.toggle("hidden", state === "boot");
  R.feedTicker.classList.toggle("hidden", state === "boot");
  R.leaderboard.classList.toggle("hidden", state === "boot");
  R.hudName.textContent = character.name;
  R.hudTitle.textContent = character.titles.length
    ? character.titles[character.titles.length - 1]
    : "";
  const hpFrac = Math.max(0, Math.min(1, run.hp / d.maxHp));
  R.hpFill.style.width = pct(hpFrac);
  R.hpLabel.textContent = `HP ${Math.ceil(run.hp)} / ${d.maxHp}`;
  const need = xpForLevel(run.level);
  R.xpFill.style.width = pct(Math.min(1, run.xp / need));
  R.xpLabel.textContent = `LV ${run.level}  ·  XP ${num(run.xp)} / ${num(need)}`;
  R.dangerFill.style.width = pct(run.danger);
  R.streakLine.textContent = `streak ${character.streak}  ·  best ${character.bestStreak}`;
  R.hudLevel.textContent = `Lv ${run.level}`;
  R.hudZone.textContent = zoneById(run.zone).name;
  R.hudGold.innerHTML = `<b class="amber">${num(character.gold)}</b> gold`;
  R.hudPrestige.innerHTML = `<b class="amber">${num(character.prestige)}</b> ✦`;
  R.hudPower.textContent = `power ${num(d.attack)}/${num(d.maxHp)}`;
  R.hudKills.textContent = `${num(character.lifetimeKills)} kills`;
  R.btnMute.textContent = H.isMuted?.() ? "SFX OFF" : "SFX ON";

  // ── panel visibility by state ───────────────────────────────────────
  const inTown = state === "town";
  const inDelve = state === "delve";
  const inCombat = state === "combat";
  R.townPanel.classList.toggle("hidden", !inTown);
  R.delveOverlay.classList.toggle("hidden", !inDelve);
  // The panic bar lives through BOTH the walk and the fight, so the player
  // always has a real-time lever to save the run.
  R.panicBar.classList.toggle("hidden", !(inDelve || inCombat));
  R.deathScreen.classList.toggle("hidden", state !== "death");

  if (inTown) renderTown(character);
  if (inDelve) renderDelve(character);
  if (inDelve || inCombat) renderPanicBar(character, hpFrac);
}

// Entering a fight: hide the walk panels and surface the panic bar, WITHOUT
// repainting the top HUD (which would snap the HP bar to the already-resolved
// final HP and spoil the playback). The combat-view animates the real journey.
export function enterCombat(character) {
  R.townPanel?.classList.add("hidden");
  R.delveOverlay?.classList.add("hidden");
  setPanicVisible(character, true);
}

export function setPanicVisible(character, show) {
  if (!R.panicBar) return;
  R.panicBar.classList.toggle("hidden", !show);
  if (show && character) refreshPanic(character);
}

// Refresh just the panic bar (potion count + danger pulse) — used mid-fight
// when the player spends a panic potion, without touching the rest of the HUD.
export function refreshPanic(character) {
  if (!R.panicBar || R.panicBar.classList.contains("hidden") || !character) return;
  const run = character.run;
  const d = derive(run, character);
  const hpFrac = Math.max(0, Math.min(1, run.hp / d.maxHp));
  renderPanicBar(character, hpFrac);
}

// ── connection / players / viewer strip ───────────────────────────────
export function setConnection(online) {
  if (R.connDot) {
    R.connDot.classList.toggle("online", !!online);
    R.connDot.textContent = online ? "connected" : "offline — playing local";
  }
}
export function setStats(players, leaderboard) {
  if (R.hudPlayers) R.hudPlayers.textContent = `${players || 1} online`;
  if (leaderboard) renderLeaderboard(leaderboard);
}
export function setViewerUrl(url) {
  const vu = document.getElementById("vs-url");
  if (vu) vu.textContent = url ? `play: ${url}` : "";
}

// ════════════════════════════════════════════════════════════════════
//  TOWN
// ════════════════════════════════════════════════════════════════════
function renderTown(character) {
  for (const b of R.townTabs.children) b.classList.toggle("active", b.dataset.tab === townTab);
  const d = derive(character.run, character);
  R.townSub.textContent = `Lv ${character.run.level} · ${num(character.gold)} gold · ${num(character.prestige)} prestige`;
  clear(R.townBody);
  if (townTab === "deploy") renderDeploy(character);
  else if (townTab === "character") renderCharacter(character, d);
  else if (townTab === "bio") renderBio(character);
  else if (townTab === "mind") renderMind(character);
  else if (townTab === "health") renderHealth(character);
  else if (townTab === "gear") renderGear(character, d);
  else if (townTab === "brain") renderBrain(character);
  else if (townTab === "drip") renderDrip(character);
}

function renderDeploy(character) {
  const run = character.run;
  const reach = Math.max(character.highestLevel || 1, run.level);
  const resting = character.posture === "rest";

  // posture — what the sigma does while you are away
  R.townBody.appendChild(
    el("div", { class: `posture-box${resting ? " resting" : ""}` }, [
      el("div", { class: "posture-info" }, [
        el("div", {
          class: "posture-state",
          text: resting
            ? "RESTING — sheltered in Ironhollow"
            : "DELVING — auto-delves while you are away",
        }),
        el("div", {
          class: "dim",
          style: { fontSize: ".8em" },
          text: resting
            ? "Safe from every attack. Earns a slow gold + prestige trickle. No run progress, no risk."
            : "Your sigma keeps delving offline — real XP and loot, but it can die. Permadeath is real.",
        }),
      ]),
      el("button", {
        class: resting ? "primary" : "",
        text: resting ? "WAKE — resume delving" : "REST — keep my sigma safe",
        onClick: () => H.onSetPosture?.(resting ? "delve" : "rest"),
      }),
    ]),
  );

  // supplies row
  R.townBody.appendChild(
    el("div", { class: "bank-bar", style: { marginTop: 0, borderTop: "none" } }, [
      el("div", {
        html: `<span class="label">supplies</span> &nbsp; potions <b class="amber">${run.potions}/${POTION_MAX}</b>`,
      }),
      el("button", {
        text: `BUY POTION (${POTION_COST}g)`,
        disabled: character.gold < POTION_COST || run.potions >= POTION_MAX,
        onClick: () => H.onBuyPotion?.(),
      }),
      el("div", { class: "dim", style: { fontSize: ".8em" }, text: "heal 45% HP mid-fight" }),
    ]),
  );

  const grid = el("div", { class: "zone-grid", style: { marginTop: "1em" } });
  for (const z of ZONES) {
    if (z.safe) continue;
    const locked = z.minLevel > reach;
    const current = run.zone === z.id;
    grid.appendChild(
      el("div", { class: `zone-card${locked ? " locked" : ""}${current ? " current" : ""}` }, [
        el("h3", { text: z.name }),
        el("div", { class: "zc-flavor", text: z.flavor }),
        el("div", { class: "zc-stats" }, [
          el("span", { html: `lvl <b>${z.minLevel}+</b>` }),
          el("span", { html: `xp <b>x${z.xpMult}</b>` }),
          el("span", {
            html: `danger <b>${z.dangerMult < 1 ? "low" : z.dangerMult < 1.3 ? "med" : "high"}</b>`,
          }),
        ]),
        locked
          ? el("button", { disabled: true, text: `LOCKED — reach Lv ${z.minLevel}` })
          : el("button", {
              class: "primary",
              text: "DEPLOY",
              onClick: () => H.onDeploy?.(z.id),
            }),
      ]),
    );
  }
  R.townBody.appendChild(grid);
}

function renderCharacter(character, d) {
  const run = character.run;
  if (run.statPoints > 0) {
    R.townBody.appendChild(
      el("div", {
        class: "points-banner",
        text: `${run.statPoints} stat point${run.statPoints > 1 ? "s" : ""} to spend — click + to allocate`,
      }),
    );
  }
  const grid = el("div", { class: "sheet-grid" });

  // left: the 7 stats
  const statCol = el("div");
  for (const k of STAT_KEYS) {
    statCol.appendChild(
      el("div", { class: "stat-row" }, [
        el("span", { class: "sr-name", text: STAT_LABEL[k] }),
        el("span", { class: "sr-val", text: String(run.stats[k]) }),
        el("button", {
          class: "mini",
          text: "+",
          disabled: run.statPoints <= 0,
          onClick: () => H.onAllocate?.(k),
        }),
        el("span", { class: "sr-blurb", text: STAT_BLURB[k] }),
      ]),
    );
  }
  // respec presets
  const presets = el("div", { class: "preset-row" }, [
    el("span", { class: "label", text: "respec → " }),
  ]);
  for (const key of Object.keys(BUILD_PRESETS)) {
    presets.appendChild(
      el("button", {
        class: "mini",
        text: BUILD_PRESETS[key].label,
        onClick: () => H.onRespec?.(key),
      }),
    );
  }
  statCol.appendChild(presets);
  grid.appendChild(statCol);

  // right: derived sheet
  const dg = el("div", { class: "derived-grid" });
  const row = (label, val) => dg.appendChild(el("div", { html: `${label}<span>${val}</span>` }));
  row("Max HP", num(d.maxHp));
  row("Attack", num(d.attack));
  row("Defense", num(d.defense));
  row("Crit", pct(d.critChance));
  row("Crit Power", `x${d.critMult.toFixed(2)}`);
  row("Haste", d.speed.toFixed(2));
  row("Evasion", pct(d.dodge));
  row("Overload", pct(d.overload));
  row("Loot Qty", `x${d.lootQty.toFixed(2)}`);
  row("Loot Luck", `+${(d.lootRarity * 100).toFixed(0)}`);
  row("Danger Rate", `x${d.dangerMult.toFixed(2)}`);
  row("Death Save", pct(d.deathSave));
  const rightCol = el("div", {}, [
    el("div", { class: "label", style: { marginBottom: ".4em" }, text: "derived combat sheet" }),
    dg,
    d.effects.length
      ? el("div", { style: { marginTop: ".8em" } }, [
          el("div", { class: "label", text: "legendary effects" }),
          ...d.effects.map((e) =>
            el("div", { class: "r-legendary", style: { fontSize: ".85em" }, text: `◆ ${e}` }),
          ),
        ])
      : null,
  ]);
  grid.appendChild(rightCol);
  R.townBody.appendChild(grid);
}

// ── RimWorld panels: Bio, Mind, Health ────────────────────────────────
function renderBio(character) {
  const traits = character.traits || [];
  const bs = character.backstory
    ? backstoryBio(character.backstory.childhood, character.backstory.adulthood)
    : null;
  const teller = STORYTELLERS[character.storyteller] || null;

  const sec = el("div", { class: "bio-panel" });

  if (bs) {
    sec.appendChild(el("div", { class: "label", text: "BACKSTORY" }));
    sec.appendChild(
      el("div", { class: "bio-block" }, [
        el("div", { class: "bio-title", text: `Childhood — ${bs.childhood}` }),
        el("div", { class: "bio-text", text: bs.childBio }),
      ]),
    );
    sec.appendChild(
      el("div", { class: "bio-block" }, [
        el("div", { class: "bio-title", text: `Adulthood — ${bs.adulthood}` }),
        el("div", { class: "bio-text", text: bs.adultBio }),
      ]),
    );
  }

  sec.appendChild(el("div", { class: "label", style: { marginTop: ".8em" }, text: "TRAITS" }));
  if (traits.length) {
    const list = el("div", { class: "trait-list" });
    for (const id of traits) {
      const t = traitById(id);
      if (!t) continue;
      list.appendChild(
        el("div", { class: "trait-row" }, [
          el("span", { class: "trait-name", text: t.name }),
          el("span", { class: "trait-blurb", text: t.blurb }),
        ]),
      );
    }
    sec.appendChild(list);
  } else {
    sec.appendChild(el("div", { class: "muted", text: "None — a blank slate." }));
  }

  if (teller) {
    sec.appendChild(
      el("div", { class: "label", style: { marginTop: ".8em" }, text: "STORYTELLER" }),
    );
    sec.appendChild(
      el("div", { class: "bio-block" }, [
        el("div", { class: "bio-title", text: teller.name }),
        el("div", { class: "bio-text", text: teller.blurb }),
      ]),
    );
  }

  R.townBody.appendChild(sec);
}

function renderMind(character) {
  const mood = character.mood || { value: 50, thoughts: [], baseline: 50 };
  const band = moodBand(mood.value);
  const color = MOOD_BAND_COLOR[band];
  const label = MOOD_BAND_LABEL[band];

  // Mood header.
  const head = el("div", { class: "mood-head", style: { borderColor: color } }, [
    el("div", { class: "mood-num", text: `${Math.round(mood.value)}`, style: { color } }),
    el("div", { class: "mood-band", text: label, style: { color } }),
    el("div", {
      class: "muted",
      text: `baseline ${Math.round(mood.baseline)} — thoughts: ${mood.thoughts.length}`,
    }),
  ]);
  R.townBody.appendChild(head);

  // Active break / inspiration banner.
  const run = character.run;
  if (run?.activeBreak) {
    const def = breakById(run.activeBreak.id);
    if (def) {
      R.townBody.appendChild(
        el("div", { class: "break-banner", style: { borderColor: "#ff4d6d" } }, [
          el("b", { text: `BREAK — ${def.name} ` }),
          el("span", { text: `(${run.activeBreak.ticksLeft} ticks left)` }),
          el("div", { class: "muted", text: def.description }),
        ]),
      );
    }
  }
  if (run?.activeInspiration) {
    const def = inspirationById(run.activeInspiration.id);
    if (def) {
      R.townBody.appendChild(
        el("div", { class: "break-banner", style: { borderColor: "#ffe44d" } }, [
          el("b", { text: `INSPIRED — ${def.name} ` }),
          el("span", { text: `(${run.activeInspiration.ticksLeft} ticks left)` }),
          el("div", { class: "muted", text: def.description }),
        ]),
      );
    }
  }

  // Live thoughts list.
  if (mood.thoughts.length) {
    R.townBody.appendChild(
      el("div", { class: "label", style: { marginTop: ".7em" }, text: "THOUGHTS" }),
    );
    const list = el("div", { class: "thought-list" });
    for (const t of mood.thoughts) {
      list.appendChild(
        el("div", { class: "thought-row" }, [
          el("span", {
            class: t.amount >= 0 ? "th-good" : "th-bad",
            text: `${t.amount >= 0 ? "+" : ""}${t.amount}`,
          }),
          el("span", { class: "th-id", text: t.id }),
          el("span", { class: "muted", text: `${Math.round(t.ticksLeft)}t` }),
        ]),
      );
    }
    R.townBody.appendChild(list);
  }

  // Skills.
  R.townBody.appendChild(
    el("div", { class: "label", style: { marginTop: ".8em" }, text: "SKILLS" }),
  );
  const skills = character.skills || {};
  const skillGrid = el("div", { class: "skill-grid" });
  for (const id of Object.keys(SKILLS)) {
    const s = skills[id] || { level: 0, xp: 0, passion: 0 };
    const flames = s.passion >= 2 ? "🔥🔥" : s.passion === 1 ? "🔥" : "·";
    const xpNeeded = xpForSkillLevel(s.level);
    skillGrid.appendChild(
      el("div", { class: "skill-row" }, [
        el("span", { class: "sk-name", text: SKILLS[id].name }),
        el("span", { class: "sk-level", text: `Lv ${s.level}` }),
        el("span", { class: "sk-passion", text: flames }),
        el("span", {
          class: "sk-bar",
          html: `<i style="width:${Math.min(100, Math.round((s.xp / xpNeeded) * 100))}%"></i>`,
        }),
        el("span", { class: "muted sk-mul", text: `x${passionMul(s.passion).toFixed(2)}` }),
      ]),
    );
  }
  R.townBody.appendChild(skillGrid);
}

function renderHealth(character) {
  const run = character.run;
  const injuries = injuryList(run);
  const diseases = diseaseList(run);

  R.townBody.appendChild(el("div", { class: "label", text: "BODY" }));
  if (injuries.length) {
    const list = el("div", { class: "wound-list" });
    for (const w of injuries) {
      list.appendChild(
        el("div", { class: "wound-row" }, [
          el("span", { class: "wd-part", text: w.partName }),
          el("span", {
            class: "wd-sev",
            text: w.label,
            style: {
              color:
                w.severity === "lost"
                  ? "#ff4d6d"
                  : w.severity === "scar"
                    ? "#ff9d2e"
                    : w.severity === "serious"
                      ? "#ffe44d"
                      : "#9aa4b2",
            },
          }),
          el("span", {
            class: "muted",
            text: Number.isFinite(w.ticksLeft) ? `${w.ticksLeft}t` : "",
          }),
        ]),
      );
    }
    R.townBody.appendChild(list);
  } else {
    R.townBody.appendChild(el("div", { class: "muted", text: "No injuries." }));
  }

  R.townBody.appendChild(
    el("div", { class: "label", style: { marginTop: ".8em" }, text: "DISEASES" }),
  );
  if (diseases.length) {
    const list = el("div", { class: "wound-list" });
    for (const d of diseases) {
      list.appendChild(
        el("div", { class: "wound-row" }, [
          el("span", { class: "wd-part", text: d.name }),
          el("span", {
            class: "wd-sev",
            html: `severity <b>${(d.severity * 100).toFixed(0)}%</b> · immunity <b>${(d.immunity * 100).toFixed(0)}%</b>`,
          }),
        ]),
      );
    }
    R.townBody.appendChild(list);
  } else {
    R.townBody.appendChild(el("div", { class: "muted", text: "Clean bill." }));
  }
}

function itemDot(rarity) {
  return el("span", { class: "ii-dot", style: { background: RARITY_COLOR[rarity] || "#888" } });
}
function affixSummary(item) {
  return (item.affixes || []).map(affixText).join("  ");
}

function renderGear(character, _d) {
  const run = character.run;
  // equipped slots
  const slots = el("div", { class: "gear-slots" });
  for (const slot of GEAR_SLOTS) {
    const it = run.gear[slot];
    slots.appendChild(
      el("div", { class: `gear-slot${it ? "" : " empty"}` }, [
        el("div", { class: "gs-label", text: GEAR_SLOT_LABEL[slot] }),
        it
          ? el("div", {}, [
              el("div", { class: `gs-name r-${it.rarity}`, text: it.name }),
              el("div", {
                class: "dim",
                style: { fontSize: ".72em" },
                text: `pow ${num(itemPower(it))}`,
              }),
              el("button", {
                class: "mini",
                text: "UNEQUIP",
                onClick: () => H.onUnequip?.(slot),
              }),
            ])
          : el("div", { class: "gs-name", text: "— empty —" }),
      ]),
    );
  }
  R.townBody.appendChild(el("div", { class: "label", text: "equipped" }));
  R.townBody.appendChild(slots);

  // inventory
  R.townBody.appendChild(
    el("div", { class: "label", text: `stash — ${run.inventory.length} items` }),
  );
  const list = el("div", { class: "inv-list" });
  if (!run.inventory.length) {
    list.appendChild(
      el("div", {
        class: "dim",
        style: { padding: ".6em" },
        text: "empty — go delve and drag some loot back",
      }),
    );
  }
  // sort: best power first
  const sorted = run.inventory
    .map((it, i) => ({ it, i }))
    .sort((a, b) => itemPower(b.it) - itemPower(a.it));
  for (const { it } of sorted) {
    const equipped = run.gear[it.slot];
    const diff = itemPower(it) - itemPower(equipped);
    list.appendChild(
      el("div", { class: `inv-item bd-${it.rarity}`, style: { borderLeftWidth: "3px" } }, [
        itemDot(it.rarity),
        el("div", { class: "ii-main" }, [
          el("div", { class: `ii-name r-${it.rarity}`, text: `${it.name}` }),
          el("div", {
            class: "ii-affix",
            text: `${GEAR_SLOT_LABEL[it.slot]} · ${affixSummary(it)}${it.effect ? ` · ◆ ${it.effect}` : ""}`,
          }),
        ]),
        el("span", { class: "ii-pow" }, [
          `${num(itemPower(it))} `,
          diff !== 0
            ? el("span", {
                class: diff > 0 ? "ii-up" : "ii-down",
                text: diff > 0 ? `▲${num(diff)}` : `▼${num(-diff)}`,
              })
            : null,
        ]),
        el("div", { class: "inv-actions" }, [
          el("button", {
            class: "mini",
            text: "EQUIP",
            onClick: () => H.onEquip?.(it.id),
          }),
          el("button", {
            class: "mini",
            text: `SELL ${num(it.value)}g`,
            onClick: () => H.onSell?.(it.id),
          }),
        ]),
      ]),
    );
  }
  R.townBody.appendChild(list);

  // bank-all
  let total = 0;
  for (const it of run.inventory) total += it.value || 0;
  R.townBody.appendChild(
    el("div", { class: "bank-bar" }, [
      el("div", {
        html: `bank the whole stash → <b class="amber">${num(total)} gold</b> + prestige`,
      }),
      el("button", {
        class: "primary",
        text: "BANK ALL",
        disabled: !run.inventory.length,
        onClick: () => H.onBankAll?.(),
      }),
    ]),
  );
}

function renderBrain(character) {
  const ai = character.run.ai;
  R.townBody.appendChild(
    el("div", {
      class: "dim",
      style: { marginBottom: ".8em" },
      text: "Your auto-battler brain. This IS your build — it fights for you, live and offline.",
    }),
  );

  const slider = (key, label, sub, asPct) => {
    const [min, max] = AI_BOUNDS[key];
    const step = asPct ? 0.05 : 1;
    const valEl = el("span", { class: "ai-val", text: asPct ? pct(ai[key]) : String(ai[key]) });
    return el("div", { class: "ai-row" }, [
      el("div", { class: "ai-name" }, [label, el("small", { text: sub })]),
      el("input", {
        type: "range",
        min,
        max,
        step,
        value: ai[key],
        oninput: (e) => {
          const v = asPct ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
          valEl.textContent = asPct ? pct(v) : String(v);
          H.onAi?.({ [key]: v });
        },
      }),
      valEl,
    ]);
  };
  R.townBody.appendChild(
    slider("fleeHpFrac", "Flee at HP", "bail out of a fight this low — heads home hurt", true),
  );
  R.townBody.appendChild(slider("potionHpFrac", "Potion at HP", "quaff a potion below this", true));
  R.townBody.appendChild(
    slider("retreatDanger", "Retreat at Danger", "walk back to town once danger hits this", true),
  );
  R.townBody.appendChild(
    slider("retreatDepth", "Retreat at Depth", "or once this deep — cash out", false),
  );

  // target priority
  const sel = el("select", {
    onchange: (e) => H.onAi?.({ targetPriority: e.target.value }),
  });
  for (const p of AI_TARGET_PRIORITY) {
    const o = el("option", { value: p, text: AI_TARGET_LABEL[p] });
    if (p === ai.targetPriority) o.selected = true;
    sel.appendChild(o);
  }
  R.townBody.appendChild(
    el("div", { class: "ai-row" }, [
      el("div", { class: "ai-name" }, [
        "Target Priority",
        el("small", { text: "who your sigma swings at first" }),
      ]),
      sel,
    ]),
  );

  // toggles
  const toggle = (key, label, sub) =>
    el("div", { class: "ai-row" }, [
      el("div", { class: "ai-name" }, [label, el("small", { text: sub })]),
      el("label", { class: "ai-toggle" }, [
        el("input", {
          type: "checkbox",
          checked: !!character.run.ai[key],
          onchange: (e) => H.onAi?.({ [key]: e.target.checked }),
        }),
        el("span", { text: character.run.ai[key] ? "ON" : "OFF" }),
      ]),
    ]);
  R.townBody.appendChild(
    toggle("greedMode", "Greed Mode", "hunt elites & bosses for loot — danger be damned"),
  );
  R.townBody.appendChild(toggle("avoidElites", "Avoid Elites", "duck elite fights when you can"));
}

function renderDrip(character) {
  R.townBody.appendChild(
    el("div", {
      class: "dim",
      style: { marginBottom: ".8em" },
      text: "Pure flex. Cosmetics never affect combat — they just make your sigma yours. Auras unlock at prestige milestones.",
    }),
  );
  const cos = character.cosmetics || {};

  const chipRow = (title, slot, options, current) => {
    const row = el("div", { style: { marginBottom: "1em" } }, [
      el("div", { class: "label", text: title }),
    ]);
    const grid = el("div", { class: "drip-grid" });
    for (const opt of options) {
      const equipped = current === opt.value;
      const locked = opt.locked;
      grid.appendChild(
        el(
          "div",
          {
            class: `drip-card${equipped ? " equipped" : ""}${locked ? " locked" : ""}`,
            onClick: () => {
              if (!locked) H.onCosmetic?.(slot, equipped && opt.canClear ? null : opt.value);
            },
          },
          [
            el("div", {
              class: "dc-name",
              text: opt.label + (locked ? " 🔒" : equipped ? " ✓" : ""),
            }),
          ],
        ),
      );
    }
    row.appendChild(grid);
    return row;
  };

  R.townBody.appendChild(
    chipRow(
      "Headwear",
      "hat_style",
      ["cap", "beanie", "tophat", "cowboy", "wizard", "bare"].map((v) => ({ value: v, label: v })),
      cos.hat_style || "cap",
    ),
  );
  R.townBody.appendChild(
    chipRow(
      "Hair",
      "hair_style",
      ["short", "long", "bob", "ponytail", "spiky", "afro"].map((v) => ({ value: v, label: v })),
      cos.hair_style || "short",
    ),
  );

  const auraOpts = [
    { value: "aura_bronze", label: "bronze" },
    { value: "aura_silver", label: "silver" },
    { value: "aura_royal", label: "royal" },
    { value: "aura_diamond", label: "diamond" },
    { value: "aura_mythic", label: "mythic" },
  ].map((o) => ({ ...o, locked: !character.cosmeticsUnlocked.includes(o.value), canClear: true }));
  R.townBody.appendChild(chipRow("Aura (prestige unlock)", "aura", auraOpts, cos.aura || null));

  if (character.titles.length) {
    R.townBody.appendChild(el("div", { class: "label", text: "titles earned" }));
    R.townBody.appendChild(el("div", { class: "dim", text: character.titles.join("  ·  ") }));
  }
}

// ════════════════════════════════════════════════════════════════════
//  DELVE
// ════════════════════════════════════════════════════════════════════
function renderDelve(character) {
  const run = character.run;
  R.drZone.textContent = zoneById(run.zone).name;
  R.drDepth.textContent = String(run.depth);
  R.drDanger.textContent = pct(run.danger);
  R.drDanger.style.color =
    run.danger >= DANGER_BOSS_AT
      ? "#ff4d6d"
      : run.danger >= DANGER_ELITE_AT
        ? "#ff9d2e"
        : "#ffd24a";
  R.drKills.textContent = String(run.kills);
  R.drHaul.textContent = String(run.inventory.length);
  if (R.drMind) {
    const mood = character.mood;
    if (mood) {
      const band = moodBand(mood.value);
      const color = MOOD_BAND_COLOR[band];
      const label = MOOD_BAND_LABEL[band];
      let html = `mind <b style="color:${color}">${label}</b> · ${Math.round(mood.value)}`;
      if (run.activeBreak) {
        const def = breakById(run.activeBreak.id);
        if (def) {
          html += ` · <b style="color:#ff4d6d">break: ${def.name}</b>`;
        }
      }
      if (run.activeInspiration) {
        const def = inspirationById(run.activeInspiration.id);
        if (def) {
          html += ` · <b style="color:#ffe44d">inspired: ${def.name}</b>`;
        }
      }
      if (run.diseases && Object.keys(run.diseases).length) {
        html += ` · <b style="color:#b86bff">sick</b>`;
      }
      R.drMind.innerHTML = html;
    } else {
      R.drMind.textContent = "";
    }
  }
}

export function lootToast(item) {
  if (!R.lootToasts) return;
  const t = el("div", { class: `loot-toast bd-${item.rarity}` }, [
    el("span", { class: `lt-name r-${item.rarity}`, text: item.name }),
    el("span", {
      class: "dim",
      text: ` · ${RARITY_LABEL[item.rarity]} ${GEAR_SLOT_LABEL[item.slot]}`,
    }),
  ]);
  R.lootToasts.appendChild(t);
  lootToastEls.push(t);
  while (lootToastEls.length > 6) {
    const old = lootToastEls.shift();
    old.remove();
  }
  setTimeout(() => {
    t.classList.add("fading");
  }, 3200);
  setTimeout(() => {
    t.remove();
    lootToastEls = lootToastEls.filter((x) => x !== t);
  }, 3900);
}

// ════════════════════════════════════════════════════════════════════
//  TOASTS / FEED / LEADERBOARD
// ════════════════════════════════════════════════════════════════════
export function toast(text, big = false) {
  if (!R.centerToasts) return;
  const t = el("div", { class: `center-toast${big ? " big" : ""}`, text });
  R.centerToasts.appendChild(t);
  setTimeout(
    () => {
      t.style.transition = "opacity .5s, transform .5s";
      t.style.opacity = "0";
      t.style.transform = "translateY(-16px)";
    },
    big ? 2200 : 1500,
  );
  setTimeout(() => t.remove(), big ? 2800 : 2100);
}

export function setFeed(entries) {
  if (!R.feedTrack) return;
  clear(R.feedTrack);
  if (!entries?.length) {
    R.feedTrack.appendChild(
      el("span", { class: "feed-item dim", text: "the abyss is quiet… for now" }),
    );
    return;
  }
  // duplicate the list so the marquee loop is seamless
  for (let pass = 0; pass < 2; pass += 1) {
    for (const e of entries) {
      R.feedTrack.appendChild(
        el("span", { class: `feed-item ${e.kind}` }, [
          el("span", { class: "fi-tag", text: feedTag(e.kind) }),
          el("b", { text: e.name }),
          ` ${e.detail}`,
        ]),
      );
    }
  }
}
function feedTag(kind) {
  return { death: "☠", legendary: "◆", boss: "♛", ascend: "✦", milestone: "★" }[kind] || "•";
}

function renderLeaderboard(list) {
  if (!R.lbList) return;
  clear(R.lbList);
  const myName = R.character ? R.character.name : null;
  list.forEach((p, i) => {
    R.lbList.appendChild(
      el("div", { class: `lb-row${p.name === myName ? " me" : ""}` }, [
        el("span", { class: "lb-rank", text: `${i + 1}` }),
        el("span", { class: "lb-name", text: p.name }),
        el("span", { class: "lb-prestige", text: `${num(p.prestige)}✦` }),
      ]),
    );
  });
  if (!list.length) {
    R.lbList.appendChild(
      el("div", {
        class: "dim",
        style: { padding: ".6em" },
        text: "be the first sigma on the board",
      }),
    );
  }
}

// ════════════════════════════════════════════════════════════════════
//  DEATH / OFFLINE / HOWTO
// ════════════════════════════════════════════════════════════════════
export function showDeath(summary) {
  clear(R.deathStats);
  const stat = (b, s) =>
    el("div", {}, [el("b", { text: b }), el("span", { class: "label", text: s })]);
  R.deathStats.appendChild(stat(String(summary.level), "level"));
  R.deathStats.appendChild(stat(String(summary.depth), "depth"));
  R.deathStats.appendChild(stat(String(summary.kills), "kills"));
  R.deathBy.textContent = `fell to ${summary.deathBy} in the ${summary.zoneName}`;
  // Lead with the CONVERSION. The old copy led with loss ("the run is gone —
  // the whole stash"), which reads to a new player as "the game robbed me" and
  // is why death felt purely punishing. Permadeath wipes the RUN; the account
  // keeps compounding — say that first, loudly.
  const shards = summary.shardsGained ? `  ✦ +${summary.shardsGained} shards` : "";
  R.deathPrestige.textContent = `+${summary.prestigeGained} prestige${shards} — banked to your account, forever`;
  const kept = `kept: Lv ${summary.highestLevel ?? summary.level} zone access · ${
    summary.prestige ?? "—"
  } prestige · your whole account.  gone: just this run's gear & stash.`;
  let lost = summary.beatLevel ? `★ NEW BEST — reached Lv ${summary.level}!  ${kept}` : kept;
  if (summary.unlocks?.length) {
    lost += `  unlocked: ${summary.unlocks.map((u) => u.value).join(", ")}.`;
  }
  R.deathLost.textContent = lost;
  R.deathScreen.classList.remove("hidden");
}

export function showOfflineReport(report) {
  const body = R["offline-modal-body"];
  clear(body);
  const hrs = report.durationMs / 3600000;
  const hrsText = hrs < 1 ? `${Math.round(hrs * 60)} min` : `${hrs.toFixed(1)} hrs`;

  if (report.mode === "rest") {
    body.appendChild(
      el("div", { class: "dim", text: `your sigma rested safely in Ironhollow for ${hrsText}.` }),
    );
    const grid = el("div", {
      class: "report-grid",
      style: { gridTemplateColumns: "repeat(2,1fr)" },
    });
    const rs = (b, s) =>
      grid.appendChild(
        el("div", { class: "report-stat" }, [el("b", { text: b }), el("span", { text: s })]),
      );
    rs(`+${num(report.goldGained)}`, "gold");
    rs(`+${num(report.prestigeGained)}`, "prestige");
    body.appendChild(grid);
    if (report.unlocks?.length) {
      body.appendChild(
        el("div", { style: { textAlign: "center", margin: ".4em 0" } }, [
          el("span", { class: "dim", text: "earned: " }),
          el("span", { class: "amber", text: report.unlocks.map((u) => u.value).join(", ") }),
        ]),
      );
    }
    body.appendChild(
      el("div", {
        class: "report-verdict alive",
        text: "nothing risked, nothing lost — your run is exactly where you left it.",
      }),
    );
    R["offline-modal"].classList.remove("hidden");
    return;
  }

  body.appendChild(
    el("div", {
      class: "dim",
      text: `your sigma kept delving for ${hrsText}${report.redeployedTo ? ` — auto-deployed to ${report.redeployedTo}` : ""}.`,
    }),
  );
  const grid = el("div", { class: "report-grid" });
  const rs = (b, s) =>
    grid.appendChild(
      el("div", { class: "report-stat" }, [el("b", { text: b }), el("span", { text: s })]),
    );
  rs(num(report.kills), "kills");
  rs(num(report.xpGained), "xp");
  rs(`+${report.levelsGained}`, "levels");
  rs(num(report.itemsFound), "items");
  rs(num(report.goldGained), "gold");
  rs(`+${num(report.prestigeGained)}`, "prestige");
  body.appendChild(grid);
  if (report.bestItem) {
    body.appendChild(
      el("div", { style: { textAlign: "center", margin: ".4em 0" } }, [
        el("span", { class: "dim", text: "best find: " }),
        el("span", { class: `r-${report.bestItem.rarity}`, text: report.bestItem.name }),
      ]),
    );
  }
  body.appendChild(
    el("div", {
      class: `report-verdict ${report.died ? "dead" : "alive"}`,
      text: report.died
        ? `☠ your sigma fell to ${report.deathBy} at Lv ${report.endLevel}. the run is gone — a new one waits in Ironhollow.`
        : `your sigma survived. Lv ${report.startLevel} → ${report.endLevel}. still breathing.`,
    }),
  );
  R["offline-modal"].classList.remove("hidden");
}

export function showHowTo() {
  const body = R["howto-modal-body"];
  if (!body.dataset.built) {
    const steps = [
      [
        "Your sigma is <b>always in the abyss</b> — fighting, looting, and dying even while you are gone. Come back and it kept going.",
      ],
      [
        "In <b>Ironhollow</b> (town): spend stat points, equip loot from your stash, tune your auto-battler <b>Brain</b>, then <b>DEPLOY</b> to a zone.",
      ],
      [
        "Delving is <b>automatic</b>. Your sigma fights an encounter, takes the loot, and pushes one step deeper — every couple of seconds. You watch.",
      ],
      [
        "<b>DANGER</b> climbs every fight. Past halfway, <b>elites</b> hunt you. Near the top, the <b>zone boss</b> comes for your run.",
      ],
      [
        "Hit <b>RETREAT</b> to walk back to town — bank your haul, heal up, stay alive. The run continues, safe.",
      ],
      [
        "Die in a delve and it is <b>PERMADEATH</b>: level, stats, gear and stash — all gone. Only <b>prestige, gold, cosmetics and titles</b> survive on your account.",
      ],
      [
        "Your <b>Brain</b> is your build: flee %, potion %, retreat triggers, target priority, greed mode. Set it well — it fights for you offline too.",
      ],
      [
        "<b>Greed</b> = more loot, faster danger. <b>Resolve</b> = slower danger, can cheat death. <b>Luck</b> = crits + rarer drops. Pick your poison.",
      ],
    ];
    steps.forEach((s, i) => {
      body.appendChild(
        el("div", { class: "howto-step" }, [
          el("div", { class: "hs-num", text: String(i + 1) }),
          el("div", { class: "hs-text", html: s[0] }),
        ]),
      );
    });
    body.appendChild(
      el("div", {
        class: "dim",
        style: { marginTop: ".8em", textAlign: "center" },
        text: "progress saves to this browser and the server — open the URL anywhere to keep playing.",
      }),
    );
    body.dataset.built = "1";
  }
  R["howto-modal"].classList.remove("hidden");
}

// ════════════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════════════
export function boot(status) {
  const s = document.getElementById("boot-status");
  if (s) s.textContent = status;
}
export function bootDone() {
  const b = document.getElementById("boot");
  if (b) {
    b.classList.add("gone");
    setTimeout(() => b.classList.add("hidden"), 600);
  }
}
