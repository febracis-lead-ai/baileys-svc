export const PORT = parseInt(process.env.PORT || "3002", 10);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
export const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || "./auth";
export const SHOW_QR_IN_TERMINAL =
  process.env.SHOW_QR_IN_TERMINAL === "false" ? false : true;

if (!WEBHOOK_URL) {
  console.warn(
    "[config] WEBHOOK_URL not defined; webhooks will have no destination."
  );
}
if (!WEBHOOK_SECRET) {
  console.warn(
    "[config] WEBHOOK_SECRET is empty; HMAC signatures will be omitted."
  );
}
