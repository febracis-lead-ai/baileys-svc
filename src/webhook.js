import {
  WEBHOOK_URL,
  WEBHOOK_AUTH_TYPE,
  WEBHOOK_AUTH_USER,
  WEBHOOK_AUTH_PASSWORD,
  WEBHOOK_AUTH_TOKEN,
} from "./config.js";

export async function sendWebhook(sessionId, event, payload) {
  if (!WEBHOOK_URL) return { ok: false, reason: "no-webhook-url" };

  const bodyObj = { sessionId, event, payload, ts: Date.now() };
  const body = JSON.stringify(bodyObj);

  const headers = { "Content-Type": "application/json" };

  if (
    WEBHOOK_AUTH_TYPE === "basic" &&
    WEBHOOK_AUTH_USER &&
    WEBHOOK_AUTH_PASSWORD
  ) {
    const credentials = Buffer.from(
      `${WEBHOOK_AUTH_USER}:${WEBHOOK_AUTH_PASSWORD}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  } else if (WEBHOOK_AUTH_TYPE === "token" && WEBHOOK_AUTH_TOKEN) {
    headers["Authorization"] = `Token ${WEBHOOK_AUTH_TOKEN}`;
  } else if (WEBHOOK_AUTH_TYPE === "bearer" && WEBHOOK_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${WEBHOOK_AUTH_TOKEN}`;
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
