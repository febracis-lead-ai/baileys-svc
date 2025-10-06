import { rm } from "fs/promises";

import NodeCache from "node-cache";

import { useMultiFileAuthState, Browsers } from "@whiskeysockets/baileys";

import { AUTH_BASE_DIR } from "../config.js";
import { makeSocketForSession } from "./socket-factory.js";

export const sessions = new Map(); // sessionId -> { id, sock, state, saveCreds, caches, lastQR, status }

export async function ensureSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const authDir = `${AUTH_BASE_DIR}/${sessionId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

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

export async function restartSession(sessionId) {
  const s = getSession(sessionId);
  if (s.sock?.ws?.close) {
    try {
      s.sock.ws.close(1000, "restart requested");
    } catch {}
  }
  s.sock = await makeSocketForSession(s);
  return s;
}

export async function logoutSession(sessionId) {
  const s = getSession(sessionId);
  if (s.sock) {
    try {
      await s.sock.logout();
    } catch {}
  }
  sessions.delete(sessionId);

  const authDir = `${AUTH_BASE_DIR}/${sessionId}`;
  try {
    await rm(authDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Error deleting directory ${authDir}:`, err);
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
