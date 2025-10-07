import express from "express";
import { PORT } from "./config.js";
import { router as sessionsRouter } from "./sessions/routes.js";
import { router as messagesRouter } from "./messages/routes.js";
import { router as contactsRouter } from "./contacts/routes.js";

const app = express();
app.use(express.json({ limit: "15mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use("/sessions", sessionsRouter);
app.use("/messages", messagesRouter);
app.use("/contacts", contactsRouter);

app.listen(PORT, () => {
  console.log(`Baileys (Bun) REST on :${PORT}`);
});
