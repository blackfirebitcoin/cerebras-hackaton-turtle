// SIGMA ABYSS — local persistence.
//
// localStorage is the *cache* and the home of the anonymous player
// token; the server is the source of truth across devices. Everything
// is wrapped — localStorage throws in private-browsing / quota cases and
// that must never break the boot.

const KEY = "sigma_abyss_save_v1";

export function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    return {
      token: typeof j.token === "string" ? j.token : null,
      character: j.character && typeof j.character === "object" ? j.character : null,
      savedAt: typeof j.savedAt === "number" ? j.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveLocal(token, character) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, character, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearLocal() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
