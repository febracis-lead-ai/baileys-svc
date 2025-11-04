export const PORT = parseInt(process.env.PORT || "3001", 10);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
export const WEBHOOK_AUTH_TYPE = process.env.WEBHOOK_AUTH_TYPE || "";
export const WEBHOOK_AUTH_USER = process.env.WEBHOOK_AUTH_USER || "";
export const WEBHOOK_AUTH_PASSWORD = process.env.WEBHOOK_AUTH_PASSWORD || "";
export const WEBHOOK_AUTH_TOKEN = process.env.WEBHOOK_AUTH_TOKEN || "";
export const AUTH_BASE_DIR = process.env.AUTH_BASE_DIR || "./auth";
export const SHOW_QR_IN_TERMINAL =
  process.env.SHOW_QR_IN_TERMINAL === "false" ? false : true;

// Redis Configuration
export const REDIS_HOST = process.env.REDIS_HOST || "redis";
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
export const REDIS_DB = parseInt(process.env.REDIS_DB || "0", 10);
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD || "";
export const REDIS_URL = process.env.REDIS_URL || "";

// Webhook Filters
export const WEBHOOK_SKIP_STATUS = process.env.WEBHOOK_SKIP_STATUS !== "false";
export const WEBHOOK_SKIP_GROUPS = process.env.WEBHOOK_SKIP_GROUPS === "false";
export const WEBHOOK_SKIP_CHANNELS = process.env.WEBHOOK_SKIP_CHANNELS !== "false";
export const WEBHOOK_SKIP_BLOCKED = process.env.WEBHOOK_SKIP_BLOCKED === "false";
export const WEBHOOK_ALLOWED_EVENTS = process.env.WEBHOOK_ALLOWED_EVENTS || "";
export const WEBHOOK_DENIED_EVENTS = process.env.WEBHOOK_DENIED_EVENTS || "";

export const KEEP_ALIVE_PING_INTERVAL = parseInt(
  process.env.KEEP_ALIVE_PING_INTERVAL || "30000",
  10
);
export const KEEP_ALIVE_PONG_TIMEOUT = parseInt(
  process.env.KEEP_ALIVE_PONG_TIMEOUT || "10000",
  10
);
export const KEEP_ALIVE_MAX_MISSED_PONGS = parseInt(
  process.env.KEEP_ALIVE_MAX_MISSED_PONGS || "3",
  10
);
export const HEALTH_CHECK_INTERVAL = parseInt(
  process.env.HEALTH_CHECK_INTERVAL || "60000",
  10
);
export const MAX_IDLE_TIME = parseInt(
  process.env.MAX_IDLE_TIME || "300000",
  10
);
export const AUTO_RECONNECT = process.env.AUTO_RECONNECT !== "false";
export const MAX_RECONNECT_ATTEMPTS = parseInt(
  process.env.MAX_RECONNECT_ATTEMPTS || "10",
  10
);

// Sentry Configuration
export const SENTRY_DSN = process.env.SENTRY_DSN || "";
export const SENTRY_TRACES_SAMPLE_RATE = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1");

/**
 * Get Redis connection options
 */
export function getRedisConfig() {
  if (REDIS_URL && !process.env.REDIS_HOST) {
    return REDIS_URL;
  }

  const config = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    db: REDIS_DB,
  };

  if (REDIS_PASSWORD) {
    config.password = REDIS_PASSWORD;
  }

  return config;
}

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
      "[config] WEBHOOK_AUTH_TYPE is 'basic' but WEBHOOK_AUTH_USER or WEBHOOK_AUTH_PASSWORD is not defined."
    );
  }
} else if (WEBHOOK_AUTH_TYPE === "token" || WEBHOOK_AUTH_TYPE === "bearer") {
  if (!WEBHOOK_AUTH_TOKEN) {
    console.warn(
      `[config] WEBHOOK_AUTH_TYPE is '${WEBHOOK_AUTH_TYPE}' but WEBHOOK_AUTH_TOKEN is not defined.`
    );
  }
} else {
  console.warn(
    `[config] WEBHOOK_AUTH_TYPE is set to unknown value '${WEBHOOK_AUTH_TYPE}'.`
  );
}

console.log("[config] Redis:", {
  host: REDIS_HOST,
  port: REDIS_PORT,
  db: REDIS_DB,
  hasPassword: !!REDIS_PASSWORD,
});

console.log("[config] Webhook Filters:", {
  skipStatus: WEBHOOK_SKIP_STATUS,
  skipGroups: WEBHOOK_SKIP_GROUPS,
  skipChannels: WEBHOOK_SKIP_CHANNELS,
  skipBlocked: WEBHOOK_SKIP_BLOCKED,
  allowedEvents: WEBHOOK_ALLOWED_EVENTS || "all",
  deniedEvents: WEBHOOK_DENIED_EVENTS || "none",
});

console.log("[config] Connection Health:", {
  pingInterval: `${KEEP_ALIVE_PING_INTERVAL}ms`,
  pongTimeout: `${KEEP_ALIVE_PONG_TIMEOUT}ms`,
  maxMissedPongs: KEEP_ALIVE_MAX_MISSED_PONGS,
  healthCheckInterval: `${HEALTH_CHECK_INTERVAL}ms`,
  maxIdleTime: `${MAX_IDLE_TIME}ms`,
  autoReconnect: AUTO_RECONNECT,
  maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
});

console.log("[config] Sentry:", {
  dsnConfigured: !!SENTRY_DSN,
  tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
  environment: process.env.NODE_ENV || "production",
});