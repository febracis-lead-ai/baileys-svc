import { Router } from "express";
import {
  ensureSession,
  getSession,
  restartSession,
  logoutSession,
  listSessions,
} from "./manager.js";

export const router = Router();

// Create/ensure session
router.post("/:id/init", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
    res.json({ ok: true, id: s.id, status: s.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

router.get("/", (_req, res) => res.json(listSessions()));

// Status/QR
router.get("/:id/status", (req, res) => {
  try {
    const s = getSession(req.params.id);
    res.json({ id: s.id, status: s.status, hasQR: !!s.lastQR });
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e) });
  }
});
router.get("/:id/qr", (req, res) => {
  try {
    const s = getSession(req.params.id);
    if (!s.lastQR) return res.status(404).json({ error: "QR unavailable" });
    res.json({ qr: s.lastQR });
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e) });
  }
});

// Pairing code (E.164 without '+')
router.post("/:id/pairing-code", async (req, res) => {
  try {
    const s = getSession(req.params.id);
    const { phoneE164NoPlus } = req.body || {};
    const code = await s.sock.requestPairingCode(phoneE164NoPlus);
    res.json({ code });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// Disconnect / Logout
router.post("/:id/disconnect", (req, res) => {
  try {
    const s = getSession(req.params.id);
    if (s.sock?.ws?.close) s.sock.ws.close(1000, "manual disconnect");
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});
router.post("/:id/logout", async (req, res) => {
  try {
    await logoutSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});
