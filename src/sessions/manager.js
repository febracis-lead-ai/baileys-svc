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
    status: "init",
    reconnectAttempts: 0,
    caches: {
      groups: new NodeCache({ stdTTL: 300 }),
      messages: new NodeCache({ stdTTL: 6 * 3600, checkperiod: 300 }),
      contacts: new NodeCache({ stdTTL: 6 * 3600, checkperiod: 300 }),
    },
    browser: Browsers.macOS("Chrome"),
    sock: null,
    redis,
    _cleanup: null,
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

  if (s._cleanup) {
    try {
      s._cleanup();
    } catch (e) {
      console.warn(`[${sessionId}] Cleanup error:`, e.message);
    }
  }

  if (s.sock?.ev) {
    try {
      s.sock.ev.removeAllListeners();
    } catch (e) {
      console.warn(`[${sessionId}] Error removing listeners:`, e.message);
    }
  }

  if (s.sock?.ws) {
    try {
      if (s.sock.ws.readyState === 1) {
        s.sock.ws.close(1000, "restart requested");
      }
      await new Promise(resolve => {
        if (s.sock.ws.readyState === 3) {
          resolve();
        } else {
          const timeout = setTimeout(resolve, 2000);
          s.sock.ws.once('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        }
      });
    } catch (e) {
      console.warn(`[${sessionId}] WebSocket close error:`, e.message);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  s.sock = await makeSocketForSession(s);
  s.status = "init";

  return s;
}

export async function logoutSession(sessionId) {
  const s = getSession(sessionId);

  if (s._cleanup) {
    try {
      s._cleanup();
    } catch (e) {
      console.warn(`[${sessionId}] Cleanup error:`, e.message);
    }
  }

  if (s.sock) {
    try {
      if (s.sock.ev) {
        s.sock.ev.removeAllListeners();
      }
      await s.sock.logout();
    } catch (e) {
      console.warn(`[${sessionId}] Logout error:`, e.message);
    }
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
      reconnectAttempts: s.reconnectAttempts || 0,
    };
  });
}

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

export function getActualSessionStatus(session) {
  const credCheck = validateCredentials(session.state);
  const hasValidCreds = credCheck.valid;

  const baileyStatus = session.status;

  let actualStatus = baileyStatus || "close";
  let isAuthenticated = false;

  // Verifica WebSocket state real
  let wsState = session.sock?.ws?.readyState;
  let isWsConnected = wsState === 1; // WebSocket.OPEN

  if (baileyStatus === "open" && hasValidCreds && isWsConnected) {
    actualStatus = "open";
    isAuthenticated = true;
  } else if (baileyStatus === "connecting") {
    actualStatus = "connecting";
    isAuthenticated = false;
  } else if (!hasValidCreds) {
    actualStatus = "invalid_credentials";
    isAuthenticated = false;
  } else if (!isWsConnected && baileyStatus === "open") {
    // Status diz "open" mas WebSocket não está conectado
    actualStatus = "connection_lost";
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
    wsState,
    isWsConnected,
    debug: {
      baileyStatus,
      hasValidCreds,
      hasSock: !!session.sock,
      wsState: getWebSocketStateText(wsState),
      credentialCheck: credCheck,
    }
  };
}

function getWebSocketStateText(state) {
  switch (state) {
    case 0: return "CONNECTING";
    case 1: return "OPEN";
    case 2: return "CLOSING";
    case 3: return "CLOSED";
    default: return "UNKNOWN";
  }
}

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

    const wsState = session.sock?.ws?.readyState;

    if (wsState !== 1) {
      return {
        connected: false,
        reason: `WebSocket not open (state: ${getWebSocketStateText(wsState)})`,
        suggestion: "Try POST /sessions/:id/restart to reconnect",
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
      reason: "All checks passed (Baileys status is 'open' and WebSocket is OPEN)",
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