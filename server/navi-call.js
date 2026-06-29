// SIGMA ABYSS — Navi's distress-call (the new-player call-to-action).
//
// The conversion hook. The moment a brand-new chatter spawns a sigma (their
// first-ever chat line mints one in resolveTwitchSigma), Navi — the abyss
// mascot — flickers up as a Princess-Leia-style hologram on the overlay and
// begs them for help by name. It is the one cinematic that turns a passive
// browser-tab viewer into a player: "the Abyss is breaking through… you're
// our only hope. Just keep chatting."
//
// This module owns ONLY the copy + which avatar Navi wears in the projection.
// server.js fires it from /api/chat-ping on `isNew` (gated once per sigma by
// `onboarding.naviCalledAt`), broadcasts a `t:'naviCall'` frame the overlay
// renders, and echoes the chat line back through the command.reply channel.
//
// Latency note: this is an EVENT, not a steering input — it fires once, plays
// for a few seconds, and asks for nothing time-sensitive ("keep chatting").
// So the 6–30s stream delay is irrelevant; a viewer who sees it 25s late can
// still answer it perfectly by doing the only thing it asks: talk.

// Navi's projection wears a fixed, recognizable paperdoll (long hair, no hat)
// so she reads as the same character every time. The overlay tints the whole
// figure hologram-cyan, so the exact cosmetics matter less than the silhouette.
export const NAVI_AVATAR = {
  seed: 70010,
  cosmetics: { hair_style: "long", hat_style: "bare" },
};

import { FIRST_QUESTION_CTA } from "./onboarding.js";

// The hologram ends on Navi's first onboarding question (the "first trial"),
// delivered on the overlay because a plain first chat line is a presence ping
// the chat-reply channel can't answer — the cinematic IS how Q1 reaches them.
const CTA = FIRST_QUESTION_CTA;

// Distress scripts, rotated so a burst of new viewers doesn't see the same
// line twice in a row. Each is { tag, line, sub } — tag is the holo header
// ("INCOMING TRANSMISSION"), line is the dramatic hook, sub is the ask.
const SCRIPTS = [
  {
    tag: "INCOMING TRANSMISSION",
    line: "{name}… the seal is failing. I can't hold the Abyss alone.",
    sub: "Fight beside me — every word you speak swings your blade. You're our only hope.",
  },
  {
    tag: "DISTRESS SIGNAL",
    line: "A new sigma wakes — {name}, the deep heard your voice.",
    sub: "Keep speaking and you grow stronger. Don't let the dark take us both.",
  },
  {
    tag: "TRANSMISSION FROM THE DEEP",
    line: "{name}, I've been waiting for someone like you.",
    sub: "Your sigma is forged. Speak, and it strikes. Rise with me.",
  },
  {
    tag: "INCOMING TRANSMISSION",
    line: "{name} — the Abyss is breaking through. Help me hold the line.",
    sub: "Chat to fight, to level, to loot. Together we push the dark back down.",
  },
];

let rotation = 0;

// Build a Navi distress-call payload for `name` (the sigma's display name).
// `login` is the lowercase twitch handle, used only for the chat echo @mention.
export function buildNaviCall(name, login) {
  const safeName = String(name || "a new sigma").slice(0, 24);
  const at = String(login || safeName).slice(0, 32);
  const script = SCRIPTS[rotation % SCRIPTS.length];
  rotation += 1;
  const line = script.line.replace("{name}", `@${at}`);
  return {
    tag: script.tag,
    line,
    sub: script.sub,
    cta: CTA,
    seed: NAVI_AVATAR.seed,
    cosmetics: NAVI_AVATAR.cosmetics,
    // The Nightbot-style chat echo. Lands in chat via command.reply on the
    // chatter's first line (one time only) so the call also reaches people
    // reading chat, not just watching the overlay.
    chatReply: `🔷 NAVI → @${at}: the Abyss needs you. Keep chatting to fight, level & loot — !sigma to see your hero. You're our only hope.`,
  };
}
