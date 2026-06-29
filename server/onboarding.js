// SIGMA ABYSS — Navi's onboarding rite (the 3-question wizard).
//
// After Navi's distress-call hologram (navi-call.js) hooks a brand-new
// chatter, she walks them through three quick questions — answered in chat as
// commands so they survive the 6–30s stream delay (each answer is async, no
// reflex):
//
//   !os <windows|mac|linux>        what they run
//   !found <youtube|twitch|x|…>    how the Abyss found them  (attribution)
//   !agent <claude|codex|gemini|…> which coding agent rides with them
//
// Answers are recorded on `character.onboarding` (also useful lead/attribution
// data) and completing the rite pays a starter reward + a title. The flow is
// field-driven, not strictly sequential: a chatter can answer in any order, or
// finish a half-done rite days later — `recordAnswer` always replies asking for
// whatever's still missing, and pays out exactly once.
//
// chat-elixir's bridge must whitelist os/found/agent in @mmo_commands for these
// to arrive (hot-reload-safe — a module attribute, not a state-shape change).

const REWARD_GOLD = 250;
const REWARD_TITLE = "Navi's Recruit";

// ── Answer normalizers ────────────────────────────────────────────────
function normOs(raw) {
  const s = String(raw || "").toLowerCase();
  if (/\b(win|windows|win10|win11|pc)\b/.test(s) || s.startsWith("win")) return "windows";
  if (/\b(mac|macos|osx|os x|apple|darwin)\b/.test(s) || s.startsWith("mac")) return "mac";
  if (/\b(linux|ubuntu|arch|fedora|debian|pop|nix|wsl)\b/.test(s) || s.startsWith("lin"))
    return "linux";
  return null;
}
function normSource(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (!s) return null;
  const map = {
    yt: "youtube",
    youtube: "youtube",
    ttv: "twitch",
    twitch: "twitch",
    x: "x",
    twitter: "x",
    tt: "tiktok",
    tiktok: "tiktok",
    reddit: "reddit",
    google: "search",
    search: "search",
    web: "search",
    discord: "discord",
    friend: "friend",
    word: "friend",
    gh: "github",
    github: "github",
    hn: "hackernews",
    hackernews: "hackernews",
  };
  const first = s.split(/\s+/)[0];
  return map[first] || first.replace(/[^a-z0-9]/g, "").slice(0, 16) || null;
}
function normAgent(raw) {
  const s = String(raw || "").toLowerCase();
  if (/claude/.test(s)) return "claude";
  if (/codex|openai|gpt/.test(s)) return "codex";
  if (/gemini|google/.test(s)) return "gemini";
  if (/cursor/.test(s)) return "cursor";
  if (/copilot/.test(s)) return "copilot";
  if (/windsurf/.test(s)) return "windsurf";
  if (/cline|aider|continue|zed|none|other/.test(s))
    return s.match(/cline|aider|continue|zed|none|other/)[0];
  return null;
}

// ── Questions ─────────────────────────────────────────────────────────
// `prompt` is the chat instruction Navi sends; `ack(v)` is her reaction.
const QUESTIONS = [
  {
    field: "os",
    verb: "os",
    norm: normOs,
    prompt: "what realm do you fight from? !os windows · !os mac · !os linux",
    invalid: "I didn't catch that realm — try !os windows, !os mac, or !os linux.",
    ack: (v) =>
      v === "windows"
        ? "A Windows warrior! ⊞"
        : v === "mac"
          ? "A Mac mage! ⌘"
          : "A Linux ranger! 🐧",
  },
  {
    field: "source",
    verb: "found",
    norm: normSource,
    prompt: "how did the Abyss find you? !found <youtube|twitch|x|tiktok|reddit|friend|search>",
    invalid: "tell me where you came from — e.g. !found youtube",
    ack: (v) => `So ${v} led you here — noted.`,
  },
  {
    field: "agent",
    verb: "agent",
    norm: normAgent,
    prompt: "what familiar codes at your side? !agent <claude|codex|gemini|cursor|copilot>",
    invalid: "name your familiar — e.g. !agent claude",
    ack: (v) => `${v[0].toUpperCase() + v.slice(1)} — a fine companion.`,
  },
];

const QUESTION_BY_VERB = Object.fromEntries(QUESTIONS.map((q) => [q.verb, q]));

// The CTA the distress-call hologram ends on — the very first trial.
export const FIRST_QUESTION_CTA = `▸ your first trial — name your realm: !os windows · !os mac · !os linux`;

export function onboardingVerbs() {
  return QUESTIONS.map((q) => q.verb);
}

// Lazily ensure the onboarding sub-object exists (a sigma minted before this
// system loads cleanly — vOnboarding defaults every field).
export function ensureOnboarding(character) {
  if (!character.onboarding || typeof character.onboarding !== "object") {
    character.onboarding = { naviCalledAt: 0, step: 0, complete: false };
  }
  return character.onboarding;
}

// Begin the rite (called when Navi's hologram fires). Idempotent.
export function startOnboarding(character) {
  const ob = ensureOnboarding(character);
  if (!ob.complete && !ob.step) ob.step = 1;
  return ob;
}

function grantReward(character) {
  character.gold = (character.gold | 0) + REWARD_GOLD;
  if (!Array.isArray(character.titles)) character.titles = [];
  let titleGranted = false;
  if (!character.titles.includes(REWARD_TITLE)) {
    character.titles.push(REWARD_TITLE);
    titleGranted = true;
  }
  return { gold: REWARD_GOLD, title: titleGranted ? REWARD_TITLE : null };
}

// Record one answer (`verb` ∈ os|found|agent, `raw` the chatter's argument).
// Returns { ok, reply, done, recorded?, reward?, say } — `reply` goes to chat
// (Navi's voice), `say` is the short line for the overlay speech toast.
export function recordAnswer(login, character, verb, raw, _now) {
  const q = QUESTION_BY_VERB[verb];
  if (!q) return { ok: false, handled: false };
  const ob = ensureOnboarding(character);
  const value = q.norm(raw);
  if (!value) {
    return { ok: false, reply: `@${login} ${q.invalid}`, say: q.invalid };
  }
  ob[q.field] = value;

  const missing = QUESTIONS.filter((x) => !ob[x.field]);
  ob.step = Math.min(
    QUESTIONS.length,
    QUESTIONS.length - missing.length + (missing.length ? 1 : 0),
  );

  if (missing.length) {
    const ack = q.ack(value);
    return {
      ok: true,
      done: false,
      recorded: { field: q.field, value },
      reply: `@${login} ${ack} Now — ${missing[0].prompt}`,
      say: `${ack} Now — ${missing[0].prompt}`,
      progress: QUESTIONS.length - missing.length,
      total: QUESTIONS.length,
    };
  }

  // All three answered.
  const ack = q.ack(value);
  if (ob.complete) {
    return {
      ok: true,
      done: true,
      already: true,
      reply: `@${login} ${ack} You're already sworn in.`,
      say: `${ack} You're sworn in.`,
      progress: QUESTIONS.length,
      total: QUESTIONS.length,
    };
  }
  ob.complete = true;
  const reward = grantReward(character);
  const name = character.name || login;
  return {
    ok: true,
    done: true,
    recorded: { field: q.field, value },
    reward,
    reply: `@${login} ${ack} Sworn in, ${name}! +${reward.gold} gold${reward.title ? ` & the title "${reward.title}"` : ""}. Keep chatting to fight & level — !sigma to see your hero.`,
    say: `${ack} Sworn in! +${reward.gold} gold${reward.title ? ` · "${reward.title}"` : ""}`,
    progress: QUESTIONS.length,
    total: QUESTIONS.length,
  };
}
