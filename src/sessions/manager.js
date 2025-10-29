import NodeCache from "node-cache";
import { Browsers } from "@whiskeysockets/baileys";
import { useRedisAuthState } from "./redis-auth-store.js";
import { makeSocketForSession } from "./socket-factory.js";

export const sessions = new Map();

export async function ensureSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const { state, saveCreds, redis } = await useRedisAuthState(sessionId);

  const s = {
    id: sessionId,
    state,
    saveCreds,
    lastQR: null,
    status: "init",  // Will be updated by connection.update event
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
      credentialsValid: status.credentialsValid,
    };
  });
}

/**
 * Validate if credentials structure is complete
 * According to Baileys docs, state.creds.me.id must exist
 */
function validateCredentials(state) {
  try {
    if (!state?.creds?.me?.id) {
      return {
        valid: false,
        reason: "Missing state.creds.me.id (required by Baileys)"
      };
    }

    if (typeof state.creds.me.id !== 'string' || state.creds.me.id.length === 0) {
      return {
        valid: false,
        reason: "Invalid state.creds.me.id format"
      };
    }

    return {
      valid: true,
      reason: "Credentials valid",
      id: state.creds.me.id,
      name: state.creds.me.name || null,
    };
  } catch (error) {
    return {
      valid: false,
      reason: `Validation error: ${error.message}`,
    };
  }
}

/**
 * Get session status following Baileys official behavior
 * 
 * According to Baileys docs:
 * - The 'connection' field from connection.update event is the source of truth
 * - Values: "open" | "connecting" | "close"
 * - ws.readyState is NOT reliable
 * 
 * Source: https://baileys.wiki/docs/socket/connecting/
 */
export function getActualSessionStatus(session) {
  const credCheck = validateCredentials(session.state);
  const hasValidCreds = credCheck.valid;

  const baileyStatus = session.status;

  let actualStatus = baileyStatus || "close";
  let isAuthenticated = false;

  if (baileyStatus === "open" && hasValidCreds) {
    actualStatus = "open";
    isAuthenticated = true;
  } else if (baileyStatus === "connecting") {
    actualStatus = "connecting";
    isAuthenticated = false;
  } else if (!hasValidCreds) {
    actualStatus = "invalid_credentials";
    isAuthenticated = false;
  } else {
    actualStatus = "close";
    isAuthenticated = false;
  }

  return {
    actualStatus,
    isAuthenticated,
    credentialsValid: hasValidCreds,
    credentialsReason: credCheck.reason,
    baileyStatus,
    debug: {
      baileyStatus,
      hasValidCreds,
      hasSock: !!session.sock,
      credentialCheck: credCheck,
    }
  };
}

/**
 * Test if session can send messages
 */
export async function testSessionConnection(session) {
  try {
    const credCheck = validateCredentials(session.state);

    if (!credCheck.valid) {
      return {
        connected: false,
        reason: "Invalid credentials",
        details: credCheck.reason,
        suggestion: "Use POST /sessions/:id/logout to clear corrupted credentials",
      };
    }

    if (session.status !== "open") {
      return {
        connected: false,
        reason: `Session status is '${session.status}', not 'open'`,
        suggestion: session.status === "close"
          ? "Try POST /sessions/:id/restart to reconnect"
          : "Wait for connection to complete",
      };
    }

    if (!session.sock || typeof session.sock.sendMessage !== 'function') {
      return {
        connected: false,
        reason: "Socket not properly initialized"
      };
    }

    return {
      connected: true,
      reason: "All checks passed (Baileys status is 'open')",
      canSend: true,
      credentials: {
        id: credCheck.id,
        name: credCheck.name,
      },
    };
  } catch (error) {
    return {
      connected: false,
      reason: error.message,
      error: String(error)
    };
  }
}

/**
 * Check if session has corrupted credentials
 */
export function hasCorruptedCredentials(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { corrupted: false, reason: "Session not found" };

  const credCheck = validateCredentials(session.state);
  return {
    corrupted: !credCheck.valid,
    reason: credCheck.reason,
    sessionId: session.id,
  };
}