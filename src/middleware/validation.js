import { redisPool } from "../services/redis-pool.js";

export function validateSessionId(req, res, next) {
  const sessionId = req.params.id;

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({
      ok: false,
      error: "Session ID is required and must be a string",
    });
  }

  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitized !== sessionId) {
    return res.status(400).json({
      ok: false,
      error:
        "Invalid session ID format. Use only alphanumeric characters, dashes, and underscores",
    });
  }

  if (sessionId.length > 128) {
    return res.status(400).json({
      ok: false,
      error: "Session ID too long (max 128 characters)",
    });
  }

  req.params.id = sanitized;
  next();
}

export function validateMessagePayload(req, res, next) {
  const { to, type } = req.body || {};

  if (!to) {
    return res.status(400).json({
      ok: false,
      error: "Recipient 'to' is required",
    });
  }

  const allowedTypes = [
    "text",
    "image",
    "video",
    "audio",
    "document",
    "sticker",
    "poll",
    "contacts",
    "location",
  ];

  if (type && !allowedTypes.includes(type)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid message type. Allowed types: ${allowedTypes.join(", ")}`,
    });
  }

  if (type === "text" && !req.body.text) {
    return res.status(400).json({
      ok: false,
      error: "Text field is required for text messages",
    });
  }

  if (["image", "video", "audio", "document"].includes(type)) {
    if (!req.body.url && !req.body.base64) {
      return res.status(400).json({
        ok: false,
        error: `Either 'url' or 'base64' is required for ${type} messages`,
      });
    }
  }

  next();
}

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000;
    this.max = options.max || 100;
    this.keyPrefix = options.keyPrefix || "rate:";
    this.skipSuccessfulRequests = options.skipSuccessfulRequests || false;
  }

  async middleware(req, res, next) {
    const key = `${this.keyPrefix}${req.ip}`;

    try {
      const redis = await redisPool.getClient();
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.pexpire(key, this.windowMs);
      }

      const ttl = await redis.pttl(key);
      const remaining = Math.max(0, this.max - current);

      res.setHeader("X-RateLimit-Limit", this.max);
      res.setHeader("X-RateLimit-Remaining", remaining);
      res.setHeader(
        "X-RateLimit-Reset",
        new Date(Date.now() + ttl).toISOString()
      );

      if (current > this.max) {
        res.setHeader("Retry-After", Math.ceil(ttl / 1000));
        return res.status(429).json({
          ok: false,
          error: "Too many requests, please try again later",
          retryAfter: Math.ceil(ttl / 1000),
        });
      }

      if (this.skipSuccessfulRequests) {
        const originalSend = res.json;
        res.json = function (data) {
          if (res.statusCode < 400) {
            redis.decr(key).catch(console.error);
          }
          return originalSend.call(this, data);
        };
      }

      next();
    } catch (err) {
      console.error("[RateLimiter] Error:", err);
      next();
    }
  }

  getMiddleware() {
    return this.middleware.bind(this);
  }
}

export const generalLimiter = new RateLimiter({
  windowMs: 60000,
  max: 100,
  keyPrefix: "rate:general:",
});

export const messageLimiter = new RateLimiter({
  windowMs: 60000,
  max: 30,
  keyPrefix: "rate:message:",
  skipSuccessfulRequests: true,
});

export const authLimiter = new RateLimiter({
  windowMs: 300000,
  max: 5,
  keyPrefix: "rate:auth:",
});

export function authenticateApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"] || req.query.api_key;
  const expectedKey = process.env.API_KEY;

  if (!expectedKey) {
    return next();
  }

  if (!apiKey) {
    return res.status(401).json({
      ok: false,
      error: "API key is required",
    });
  }

  if (apiKey !== expectedKey) {
    return res.status(401).json({
      ok: false,
      error: "Invalid API key",
    });
  }

  next();
}

export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    };

    if (res.statusCode >= 400) {
      console.error("[API Error]", JSON.stringify(logData));
    } else if (duration > 1000) {
      console.warn("[API Slow]", JSON.stringify(logData));
    } else if (process.env.NODE_ENV === "development") {
      console.log("[API]", JSON.stringify(logData));
    }
  });

  next();
}

export function errorHandler(err, req, res, next) {
  console.error("[ErrorHandler]", {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
  });

  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;

  res.status(err.status || 500).json({
    ok: false,
    error: message,
  });
}
