export const PORT = parseInt(process.env.PORT || "3001", 10);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
export const WEBHOOK_AUTH_TYPE = process.env.WEBHOOK_AUTH_TYPE || "";
export const WEBHOOK_AUTH_USER = process.env.WEBHOOK_AUTH_USER || "";
export const WEBHOOK_AUTH_PASSWORD = process.env.WEBHOOK_AUTH_PASSWORD || "";
export const WEBHOOK_AUTH_TOKEN = process.env.WEBHOOK_AUTH_TOKEN || "";
export const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || "./auth";
export const SHOW_QR_IN_TERMINAL =
  process.env.SHOW_QR_IN_TERMINAL === "false" ? false : true;

// Webhook Filters
export const WEBHOOK_SKIP_STATUS = process.env.WEBHOOK_SKIP_STATUS !== "false";
export const WEBHOOK_SKIP_GROUPS = process.env.WEBHOOK_SKIP_GROUPS === "false";
export const WEBHOOK_SKIP_CHANNELS = process.env.WEBHOOK_SKIP_CHANNELS !== "false";
export const WEBHOOK_SKIP_BLOCKED = process.env.WEBHOOK_SKIP_BLOCKED === "false";
export const WEBHOOK_ALLOWED_EVENTS = process.env.WEBHOOK_ALLOWED_EVENTS || "";
export const WEBHOOK_DENIED_EVENTS = process.env.WEBHOOK_DENIED_EVENTS || "";

if (!WEBHOOK_URL) {
  console.warn(
    "[config] WEBHOOK_URL not defined; webhooks will have no destination."
  );
}
if (!WEBHOOK_AUTH_TYPE) {
  console.warn(
    "[config] WEBHOOK_AUTH_TYPE not defined; webhooks will be sent without authentication."
  );
} else if (WEBHOOK_AUTH_TYPE === "basic") {
  if (!WEBHOOK_AUTH_USER || !WEBHOOK_AUTH_PASSWORD) {
    console.warn(
      "[config] WEBHOOK_AUTH_TYPE is 'basic' but WEBHOOK_AUTH_USER or WEBHOOK_AUTH_PASSWORD is not defined; webhooks will be sent without authentication."
    );
  }
} else if (WEBHOOK_AUTH_TYPE === "token" || WEBHOOK_AUTH_TYPE === "bearer") {
  if (!WEBHOOK_AUTH_TOKEN) {
    console.warn(
      `[config] WEBHOOK_AUTH_TYPE is '${WEBHOOK_AUTH_TYPE}' but WEBHOOK_AUTH_TOKEN is not defined; webhooks will be sent without authentication.`
    );
  }
} else {
  console.warn(
    `[config] WEBHOOK_AUTH_TYPE is set to unknown value '${WEBHOOK_AUTH_TYPE}'; webhooks will be sent without authentication.`
  );
}

// Log filter configuration
console.log("[config] Webhook Filters:", {
  skipStatus: WEBHOOK_SKIP_STATUS,
  skipGroups: WEBHOOK_SKIP_GROUPS,
  skipChannels: WEBHOOK_SKIP_CHANNELS,
  skipBlocked: WEBHOOK_SKIP_BLOCKED,
  allowedEvents: WEBHOOK_ALLOWED_EVENTS || "all",
  deniedEvents: WEBHOOK_DENIED_EVENTS || "none",
});