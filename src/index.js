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

app.use(compression()); // Enable gzip compression
app.use(express.json({ limit: "15mb" }));
app.use(requestLogger); // Log all requests
app.use(monitor.middleware()); // Performance monitoring
app.use(authenticateApiKey); // API key authentication
app.use(generalLimiter.getMiddleware()); // General rate limiting

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

app.use(errorHandler);

const gracefulShutdown = async (signal) => {
  console.log(`\n[${signal}] Shutting down gracefully...`);

  server.close(() => {
    console.log("HTTP server closed");
  });

  webhookQueue.stopProcessing();

  const shutdownTimeout = setTimeout(() => {
    console.log("Forcing shutdown...");
    process.exit(1);
  }, 10000);

  try {
    await redisPool.disconnect();
    console.log("Redis disconnected");

    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[ERROR] Unhandled Rejection at:", promise, "reason:", reason);
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
  }
});
