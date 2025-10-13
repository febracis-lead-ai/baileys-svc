import { Router } from "express";
import {
  ensureSession,
  logoutSession,
  listSessions,
  getOrEnsureSession,
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

// Status
router.get("/:id/status", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
    res.json({ ok: true, status: s.status });
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e) });
  }
});

// QR
router.get("/:id/qr", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
    const started = Date.now();
    const timeoutMs = 15000;

    while (
      !s.lastQR &&
      s.status !== "open" &&
      Date.now() - started < timeoutMs
    ) {
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!s.lastQR) return res.status(404).json({ error: "QR unavailable" });
    res.json({ qr: s.lastQR });
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e) });
  }
});

// Pairing code (E.164 without '+')
router.post("/:id/pairing-code", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
    res.json({ code });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// Disconnect / Logout
router.post("/:id/disconnect", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
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
