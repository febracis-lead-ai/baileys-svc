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
  return Array.from(sessions.values()).map((s) => {
    const status = getActualSessionStatus(s);
    return {
      id: s.id,
      status: status.actualStatus,
      isAuthenticated: status.isAuthenticated,
      hasQR: !!s.lastQR,
    };
  });
}

/**
 * Get actual session status by checking WebSocket state and credentials
 * This ensures consistency between reported status and actual connection state
 */
export function getActualSessionStatus(session) {
  const wsState = session.sock?.ws?.readyState;
  const isWsConnected = wsState === 1; // WebSocket.OPEN = 1
  const hasAuth = !!session.state?.creds?.me?.id;

  let actualStatus = session.status;
  let isAuthenticated = false;

  if (isWsConnected && hasAuth) {
    // WebSocket is open AND we have authentication credentials
    actualStatus = "open";
    isAuthenticated = true;

    // Auto-correct session status if out of sync
    if (session.status !== "open") {
      console.log(`[${session.id}] Status auto-corrected from '${session.status}' to 'open'`);
      session.status = "open";
    }
  } else if (!isWsConnected) {
    // WebSocket is not connected
    actualStatus = "close";
    isAuthenticated = false;

    // Auto-correct session status if out of sync
    if (session.status === "open") {
      console.log(`[${session.id}] Status auto-corrected from 'open' to 'close'`);
      session.status = "close";
    }
  } else if (isWsConnected && !hasAuth) {
    // WebSocket is open but not authenticated yet (waiting for QR scan or pairing code)
    actualStatus = "connecting";
    isAuthenticated = false;
  }

  return {
    actualStatus,
    isAuthenticated,
    wsState,
    isWsConnected,
    hasAuth,
  };
}