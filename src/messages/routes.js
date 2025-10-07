import { Router } from "express";
import { getSession } from "../sessions/manager.js";

export const router = Router();

router.post("/:id/send", async (req, res) => {
  try {
    const s = getSession(req.params.id);
    const sent = await s.sock.__send(req.body);
    res.json({ ok: true, key: sent?.key });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

router.post("/:id/ack/read", async (req, res) => {
  try {
    const s = getSession(req.params.id);
    await s.sock.__read(req.body?.keys || []);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

router.post("/:id/ack/send", async (req, res) => {
  try {
    const s = getSession(req.params.id);
    const { jid, participant, ids, type } = req.body || {};
    await s.sock.__receipt(jid, participant, ids, type);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

router.post("/:id/download", async (req, res) => {
  try {
    const s = getSession(req.params.id);
    const buff = await s.sock.__download(req.body?.message);
    res.type("application/octet-stream").send(buff);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});
