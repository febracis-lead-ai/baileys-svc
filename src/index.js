import express from "express";
import { PORT } from "./config.js";
import { router as sessionsRouter } from "./sessions/routes.js";
import { router as messagesRouter } from "./messages/routes.js";
import { router as contactsRouter } from "./contacts/routes.js";
import { restoreAllSessions } from "./sessions/bootstrap.js";

const app = express();
app.use(express.json({ limit: "15mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/sessions", sessionsRouter);
app.use("/messages", messagesRouter);
app.use("/contacts", contactsRouter);

app.listen(PORT, async () => {
  console.log(`Baileys (Bun) REST on :${PORT}`);
  try {
    await restoreAllSessions(process.env.REDIS_URL);
  } catch (e) {
    console.error("[bootstrap] erro ao restaurar sessões:", e?.message || e);
  }
});
