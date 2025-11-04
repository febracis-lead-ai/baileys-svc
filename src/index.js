import { initSentry } from "./services/sentry.js";
initSentry();

import express from "express";
import compression from "compression";
import { PORT } from "./config.js";
import { router as sessionsRouter } from "./sessions/routes.js";
import { router as messagesRouter } from "./messages/routes.js";
import { router as contactsRouter } from "./contacts/routes.js";
import { restoreAllSessions } from "./sessions/bootstrap.js";
import { webhookQueue } from "./services/webhook.js";
import { getFilterConfig } from "./services/webhook-filter.js";
import { redisPool } from "./services/redis-pool.js";
import {
  authenticateApiKey,
  requestLogger,
  errorHandler,
  generalLimiter,
} from "./middleware/validation.js";
import { sentryRequestHandler, sentryErrorHandler } from "./middleware/sentry.js";
import { captureException, captureMessage } from "./services/sentry.js";
import { listSessions, getActualSessionStatus } from "./sessions/manager.js";

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      requests: 0,
      errors: 0,
      avgResponseTime: 0,
      memoryUsage: {},
      uptime: Date.now(),
    };

    setInterval(() => this.updateMemoryMetrics(), 30000);
  }

  updateMemoryMetrics() {
    const mem = process.memoryUsage();
    this.metrics.memoryUsage = {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + " MB",
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + " MB",
      rss: Math.round(mem.rss / 1024 / 1024) + " MB",
      external: Math.round(mem.external / 1024 / 1024) + " MB",
    };
  }

  middleware() {
    return (req, res, next) => {
      const start = Date.now();
      this.metrics.requests++;

      const originalEnd = res.end;
      res.end = (...args) => {
        const duration = Date.now() - start;

        this.metrics.avgResponseTime =
          (this.metrics.avgResponseTime * (this.metrics.requests - 1) +
            duration) /
          this.metrics.requests;

        if (res.statusCode >= 400) {
          this.metrics.errors++;
        }

        originalEnd.apply(res, args);
      };

      next();
    };
  }

  getMetrics() {
    return {
      ...this.metrics,
      uptime:
        Math.round((Date.now() - this.metrics.uptime) / 1000) + " seconds",
      avgResponseTime: Math.round(this.metrics.avgResponseTime) + " ms",
      errorRate:
        this.metrics.requests > 0
          ? ((this.metrics.errors / this.metrics.requests) * 100).toFixed(2) +
          "%"
          : "0%",
    };
  }
}

const app = express();
const monitor = new PerformanceMonitor();

app.use(compression());
app.use(express.json({ limit: "15mb" }));
app.use(sentryRequestHandler());
app.use(requestLogger);
app.use(monitor.middleware());
app.use(authenticateApiKey);
app.use(generalLimiter.getMiddleware());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",");

  if (!allowedOrigins[0] || allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.get("/healthz", async (_req, res) => {
  try {
    const redis = await redisPool.getClient();
    await redis.ping();

    res.json({
      ok: true,
      service: "baileys-svc",
      version: process.env.npm_package_version || "1.0.0",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    captureException(error, { context: "healthz" });
    res.status(503).json({
      ok: false,
      error: "Service unhealthy",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

app.get("/healthz/detailed", async (_req, res) => {
  try {
    const redis = await redisPool.getClient();
    const redisInfo = await redis.info("server");
    const webhookStats = await webhookQueue.getStats();

    res.json({
      ok: true,
      service: {
        name: "baileys-svc",
        version: process.env.npm_package_version || "1.0.0",
        environment: process.env.NODE_ENV || "production",
        uptime: process.uptime(),
      },
      dependencies: {
        redis: {
          connected: true,
          version: redisInfo.match(/redis_version:(.+)/)?.[1],
        },
      },
      webhooks: webhookStats,
      performance: monitor.getMetrics(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    captureException(error, { context: "healthz_detailed" });
    res.status(503).json({
      ok: false,
      error: "Service unhealthy",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

app.use("/sessions", sessionsRouter);
app.use("/messages", messagesRouter);
app.use("/contacts", contactsRouter);

app.get("/admin/metrics", (req, res) => {
  res.json(monitor.getMetrics());
});

app.get("/admin/sessions/health", async (req, res) => {
  try {
    const sessionsData = listSessions();
    const healthData = [];

    for (const sessionInfo of sessionsData) {
      try {
        const fullSession = sessions.get(sessionInfo.id);
        if (!fullSession) continue;

        const statusCheck = getActualSessionStatus(fullSession);

        const timeSinceActivity = fullSession.lastActivity
          ? Date.now() - fullSession.lastActivity
          : null;

        const timeSinceConnected = fullSession.connectedAt
          ? Date.now() - fullSession.connectedAt
          : null;

        healthData.push({
          id: sessionInfo.id,
          status: statusCheck.actualStatus,
          isAuthenticated: statusCheck.isAuthenticated,
          websocket: {
            state: statusCheck.wsState,
            stateText: getWebSocketStateText(statusCheck.wsState),
            isConnected: statusCheck.isWsConnected,
          },
          activity: {
            lastActivity: fullSession.lastActivity,
            timeSinceActivity: timeSinceActivity
              ? `${Math.round(timeSinceActivity / 1000)}s`
              : null,
            isIdle: timeSinceActivity && timeSinceActivity > 300000, // 5 min
          },
          connection: {
            connectedAt: fullSession.connectedAt,
            uptime: timeSinceConnected
              ? `${Math.round(timeSinceConnected / 1000)}s`
              : null,
            reconnectAttempts: fullSession.reconnectAttempts || 0,
          },
          credentials: {
            valid: statusCheck.credentialsValid,
            phone: fullSession.state?.creds?.me?.id || null,
            name: fullSession.state?.creds?.me?.name || null,
          },
        });
      } catch (err) {
        console.error(`[admin/health] Error processing session ${sessionInfo.id}:`, err.message);
      }
    }

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalSessions: healthData.length,
      healthy: healthData.filter(s => s.isAuthenticated).length,
      unhealthy: healthData.filter(s => !s.isAuthenticated).length,
      idle: healthData.filter(s => s.activity.isIdle).length,
      sessions: healthData,
    });
  } catch (error) {
    captureException(error, { context: "admin_sessions_health" });
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// Admin endpoint: Forçar health check em uma sessão específica
app.post("/admin/sessions/:id/force-health-check", async (req, res) => {
  try {
    const session = sessions.get(req.params.id);

    if (!session) {
      return res.status(404).json({
        ok: false,
        error: "Session not found",
      });
    }

    const statusCheck = getActualSessionStatus(session);

    if (statusCheck.actualStatus !== "open") {
      return res.status(400).json({
        ok: false,
        error: "Session is not open",
        status: statusCheck.actualStatus,
      });
    }

    // Tenta enviar presença para verificar se conexão funciona
    try {
      await session.sock.sendPresenceUpdate('available');
      session.lastActivity = Date.now();

      res.json({
        ok: true,
        message: "Health check passed - connection is working",
        lastActivity: session.lastActivity,
      });
    } catch (err) {
      captureException(err, {
        context: "force_health_check",
        sessionId: session.id
      });

      res.status(503).json({
        ok: false,
        error: "Health check failed - connection is not responding",
        details: err.message,
        suggestion: "Use POST /sessions/:id/restart to reconnect",
      });
    }
  } catch (error) {
    captureException(error, { context: "force_health_check" });
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// Admin endpoint: Verificar configurações de keep-alive
app.get("/admin/config/keep-alive", (req, res) => {
  res.json({
    ok: true,
    config: {
      pingInterval: process.env.KEEP_ALIVE_PING_INTERVAL || "30000 (default)",
      pongTimeout: process.env.KEEP_ALIVE_PONG_TIMEOUT || "10000 (default)",
      maxMissedPongs: process.env.KEEP_ALIVE_MAX_MISSED_PONGS || "3 (default)",
      healthCheckInterval: process.env.HEALTH_CHECK_INTERVAL || "60000 (default)",
      maxIdleTime: process.env.MAX_IDLE_TIME || "300000 (default)",
      autoReconnect: process.env.AUTO_RECONNECT !== "false",
      maxReconnectAttempts: process.env.MAX_RECONNECT_ATTEMPTS || "10 (default)",
    },
    description: {
      pingInterval: "Interval between keep-alive pings (ms)",
      pongTimeout: "Timeout waiting for pong response (ms)",
      maxMissedPongs: "Maximum consecutive missed pongs before reconnection",
      healthCheckInterval: "Interval between health checks (ms)",
      maxIdleTime: "Maximum time without activity before forcing check (ms)",
      autoReconnect: "Automatically reconnect on connection issues",
      maxReconnectAttempts: "Maximum reconnection attempts",
    },
    activeValues: {
      pingInterval: parseInt(process.env.KEEP_ALIVE_PING_INTERVAL || "30000"),
      pongTimeout: parseInt(process.env.KEEP_ALIVE_PONG_TIMEOUT || "10000"),
      maxMissedPongs: parseInt(process.env.KEEP_ALIVE_MAX_MISSED_PONGS || "3"),
      healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "60000"),
      maxIdleTime: parseInt(process.env.MAX_IDLE_TIME || "300000"),
      autoReconnect: process.env.AUTO_RECONNECT !== "false",
      maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "10"),
    }
  });
});

// Admin endpoint: Obter estatísticas de reconexão
app.get("/admin/sessions/:id/reconnect-stats", async (req, res) => {
  try {
    const session = sessions.get(req.params.id);

    if (!session) {
      return res.status(404).json({
        ok: false,
        error: "Session not found",
      });
    }

    const statusCheck = getActualSessionStatus(session);

    res.json({
      ok: true,
      id: session.id,
      status: statusCheck.actualStatus,
      reconnection: {
        attempts: session.reconnectAttempts || 0,
        maxAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "10"),
        autoReconnect: process.env.AUTO_RECONNECT !== "false",
        willRetry: (session.reconnectAttempts || 0) < parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "10"),
      },
      connection: {
        connectedAt: session.connectedAt,
        lastActivity: session.lastActivity,
        timeSinceActivity: session.lastActivity
          ? `${Math.round((Date.now() - session.lastActivity) / 1000)}s`
          : null,
        uptime: session.connectedAt
          ? `${Math.round((Date.now() - session.connectedAt) / 1000)}s`
          : null,
      },
      credentials: {
        valid: statusCheck.credentialsValid,
        phone: session.state?.creds?.me?.id || null,
      }
    });
  } catch (error) {
    captureException(error, { context: "reconnect_stats" });
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/admin/webhook-filters", (req, res) => {
  const config = getFilterConfig();
  res.json({
    ok: true,
    filters: config,
    examples: {
      skipStatus: "Set WEBHOOK_SKIP_STATUS=false to include status/broadcast messages",
      skipGroups: "Set WEBHOOK_SKIP_GROUPS=true to exclude group messages",
      skipChannels: "Set WEBHOOK_SKIP_CHANNELS=false to include channel messages",
      allowedEvents: "Set WEBHOOK_ALLOWED_EVENTS=messages.upsert,session.connected to whitelist events",
      deniedEvents: "Set WEBHOOK_DENIED_EVENTS=presence.update,typing to blacklist events",
    }
  });
});

app.get("/admin/webhook-stats", async (req, res) => {
  const stats = await webhookQueue.getStats();
  res.json(stats);
});

app.post("/admin/webhook-retry", async (req, res) => {
  const { count = 10 } = req.body;
  const retried = await webhookQueue.retryFailed(count);
  res.json({
    ok: true,
    retried,
    message: `Retried ${retried} failed webhooks`,
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint not found",
    path: req.path,
    method: req.method,
  });
});

app.use(sentryErrorHandler());
app.use(errorHandler);

const gracefulShutdown = async (signal) => {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  captureMessage(`Service shutting down: ${signal}`, "warning");

  server.close(() => {
    console.log("HTTP server closed");
  });

  webhookQueue.stopProcessing();

  const shutdownTimeout = setTimeout(() => {
    console.log("Forcing shutdown...");
    captureMessage("Forced shutdown after timeout", "error");
    process.exit(1);
  }, 10000);

  try {
    await redisPool.disconnect();
    console.log("Redis disconnected");

    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    captureException(error, { context: "graceful_shutdown" });
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error);
  captureException(error, { context: "uncaught_exception", fatal: true });
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[ERROR] Unhandled Rejection at:", promise, "reason:", reason);
  captureException(reason, { context: "unhandled_rejection", promise: String(promise) });
});

const server = app.listen(PORT, async () => {
  console.log(`
    ╔════════════════════════════════════════╗
    ║     Baileys WhatsApp Service (Bun)     ║
    ╠════════════════════════════════════════╣
    ║  Status: Running                       ║
    ║  Port: ${PORT.toString().padEnd(32)}║
    ║  Environment: ${(process.env.NODE_ENV || "production").padEnd(25)}║
    ║  Redis: ${(process.env.REDIS_URL ? "Connected" : "Not configured").padEnd(
    31
  )}║
    ║  Webhooks: ${(process.env.WEBHOOK_URL ? "Enabled" : "Disabled").padEnd(
    28
  )}║
    ║  Sentry: ${(process.env.SENTRY_DSN ? "Enabled" : "Disabled").padEnd(
    29
  )}║
    ╚════════════════════════════════════════╝
  `);

  try {
    console.log("[Bootstrap] Restoring sessions from Redis...");
    await restoreAllSessions();
  } catch (error) {
    console.error(
      "[Bootstrap] Failed to restore sessions:",
      error?.message || error
    );
    captureException(error, { context: "bootstrap" });
  }
});