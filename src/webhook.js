import crypto from "crypto";
import { WEBHOOK_URL, WEBHOOK_SECRET } from "./config.js";

export async function sendWebhook(sessionId, event, payload) {
  if (!WEBHOOK_URL) return { ok: false, reason: "no-webhook-url" };

  const bodyObj = { sessionId, event, payload, ts: Date.now() };
  const body = JSON.stringify(bodyObj);

  const headers = { "Content-Type": "application/json" };
  if (WEBHOOK_SECRET) {
    const sig = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
    headers["X-Signature"] = sig;
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);

  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      body,
      headers,
      signal: ac.signal,
    });
    clearTimeout(t);
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    clearTimeout(t);
    console.error("[webhook] error sending:", err?.message || err);
    return { ok: false, reason: String(err?.message || err) };
  }
}
