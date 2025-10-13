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

// Status/QR
router.get("/:id/status", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
    res.json({ ok: true, status: s.status });
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e) });
  }
});

router.get("/:id/qr", async (req, res) => {
  try {
    const s = await ensureSession(req.params.id);
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
