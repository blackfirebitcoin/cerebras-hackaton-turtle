// SIGMA ABYSS — realtime client.
//
// Thin WebSocket wrapper with exponential-backoff auto-reconnect — the
// client mirrors the server's self-healing posture: a dropped socket
// just retries, the game keeps running on local state in the meantime.

let ws = null;
let handlers = {};
let backoff = 500;
let pingTimer = null;
let manualClose = false;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

function open() {
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    backoff = 500;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: "ping" }), 25_000);
    handlers.onOpen?.();
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "welcome":
        handlers.onWelcome?.(msg);
        break;
      case "saved":
        handlers.onSaved?.(msg);
        break;
      case "feed":
        handlers.onFeed?.(msg.entry);
        break;
      case "stats":
        handlers.onStats?.(msg);
        break;
      case "error":
        handlers.onError?.(msg.msg);
        break;
      case "twitchAction":
        handlers.onTwitchAction?.(msg);
        break;
      case "pong":
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    handlers.onClose?.();
    if (!manualClose) scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect() {
  setTimeout(open, backoff);
  backoff = Math.min(backoff * 1.8, 15_000);
}

export function connect(h) {
  handlers = h || {};
  manualClose = false;
  open();
}

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function isOpen() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

export const hello = (token, name, twitch) =>
  send({
    t: "hello",
    token: token || null,
    name: name || null,
    twitch: twitch || null,
  });
export const saveCharacter = (character) => send({ t: "save", character });
export const postEvent = (entry) => send({ t: "event", event: entry });
