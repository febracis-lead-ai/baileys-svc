import NodeCache from "node-cache";
import { Browsers } from "@whiskeysockets/baileys";
import { useRedisAuthState } from "./redis-auth-store.js";
import { makeSocketForSession } from "./socket-factory.js";

export const sessions = new Map(); // sessionId -> { id, sock, state, saveCreds, caches, lastQR, status }

export async function ensureSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const { state, saveCreds, redis } = await useRedisAuthState(sessionId);

  const s = {
    id: sessionId,
    state,
    saveCreds,
    lastQR: null,
    status: "init",
    caches: {
      groups: new NodeCache({ stdTTL: 300 }),
      messages: new NodeCache({ stdTTL: 6 * 3600, checkperiod: 300 }),
      contacts: new NodeCache({ stdTTL: 6 * 3600, checkperiod: 300 }),
    },
    browser: Browsers.macOS("Chrome"),
    sock: null,
    redis,
  };

  s.sock = await makeSocketForSession(s);
  sessions.set(sessionId, s);
  return s;
}

export function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`Session '${sessionId}' not found`);
  return s;
}

export async function getOrEnsureSession(sessionId) {
  return sessions.get(sessionId) || (await ensureSession(sessionId));
}

export async function restartSession(sessionId) {
  const s = getSession(sessionId);
  if (s.sock?.ws?.close) {
    try {
      s.sock.ws.close(1000, "restart requested");
    } catch { }
  }
  s.sock = await makeSocketForSession(s);
  return s;
}

export async function logoutSession(sessionId) {
  const s = getSession(sessionId);
  if (s.sock) {
    try {
      await s.sock.logout();
    } catch { }
  }
  sessions.delete(sessionId);

  try {
    if (s.redis) {
      const prefix = `wa:${sessionId}:`;
      let cursor = "0";
      do {
        const [next, keys] = await s.redis.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          "1000"
        );
        cursor = next;
        if (keys.length) await s.redis.del(keys);
      } while (cursor !== "0");
    }
  } catch (e) {
    console.warn(
      `[logoutSession] redis cleanup failed for ${sessionId}:`,
      e.message
    );
  }

  return true;
}

export function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    status: s.status,
    hasQR: !!s.lastQR,
  }));
}
