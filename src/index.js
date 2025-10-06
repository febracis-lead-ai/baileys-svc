import express from "express";
import { PORT } from "./config.js";
import { router as sessionsRouter } from "./sessions/routes.js";

const app = express();
app.use(express.json({ limit: "15mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/sessions", sessionsRouter);

app.listen(PORT, () => {
  console.log(`Baileys (Bun) REST on :${PORT}`);
});
