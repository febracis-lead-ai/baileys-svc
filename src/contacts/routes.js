import { Router } from "express";
import { getOrEnsureSession } from "../sessions/manager.js";

export const router = Router();

router.post("/:id/contact-info", async (req, res) => {
  try {
    const s = await getOrEnsureSession(req.params.id);
    const r = await s.sock.__contactInfo(req.body?.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});
