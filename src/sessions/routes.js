import { Router } from "express";
import {
  ensureSession,
  logoutSession,
  listSessions,
  getOrEnsureSession,
  getSession,
  restartSession,
} from "./manager.js";
import {
  validateSessionId,
  authLimiter,
  generalLimiter,
} from "../middleware/validation.js";

export const router = Router();

// Apply validation to all routes with :id parameter
router.param("id", validateSessionId);

/**
 * Create or ensure a session exists
 * @route POST /sessions/:id/init
 */
router.post(
  "/:id/init",
  authLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const session = await ensureSession(req.params.id);
      res.json({
        ok: true,
        id: session.id,
        status: session.status,
        message: "Session initialized successfully",
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * List all active sessions
 * @route GET /sessions
 */
router.get("/", generalLimiter.getMiddleware(), (_req, res) => {
  const sessions = listSessions();
  res.json({
    ok: true,
    count: sessions.length,
    sessions,
  });
});

/**
 * Get session status
 * @route GET /sessions/:id/status
 */
router.get(
  "/:id/status",
  generalLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const session = await getOrEnsureSession(req.params.id);

      // Include more detailed status information
      const statusInfo = {
        ok: true,
        id: session.id,
        status: session.status,
        hasQR: !!session.lastQR,
        isAuthenticated: session.status === "open",
        connectedAt: session.connectedAt || null,
        lastActivity: session.lastActivity || null,
      };

      res.json(statusInfo);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Get QR code for authentication
 * @route GET /sessions/:id/qr
 */
router.get("/:id/qr", authLimiter.getMiddleware(), async (req, res, next) => {
  try {
    const session = await getOrEnsureSession(req.params.id);

    // Early return if already connected
    if (session.status === "open") {
      return res.status(400).json({
        ok: false,
        error: "Session already authenticated",
      });
    }

    const started = Date.now();
    const timeoutMs = parseInt(req.query.timeout || "15000", 10);
    const pollInterval = 200;

    // Poll for QR code
    while (
      !session.lastQR &&
      session.status !== "open" &&
      Date.now() - started < timeoutMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    if (!session.lastQR) {
      return res.status(404).json({
        ok: false,
        error:
          "QR code not available. Session may be connecting or already authenticated.",
        status: session.status,
      });
    }

    // Return QR in multiple formats
    res.json({
      ok: true,
      qr: session.lastQR,
      format: "raw",
      expiresAt: new Date(Date.now() + 60000).toISOString(), // QR expires in ~60s
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Request pairing code for phone number authentication
 * @route POST /sessions/:id/pairing-code
 */
router.post(
  "/:id/pairing-code",
  authLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const { phoneNumber } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({
          ok: false,
          error: "Phone number is required",
        });
      }

      // Validate phone number format (E.164 without +)
      const cleanPhone = phoneNumber.replace(/\D/g, "");
      if (cleanPhone.length < 10 || cleanPhone.length > 15) {
        return res.status(400).json({
          ok: false,
          error: "Invalid phone number format. Use E.164 format without +",
        });
      }

      const session = await ensureSession(req.params.id);

      // Check if already authenticated
      if (session.status === "open") {
        return res.status(400).json({
          ok: false,
          error: "Session already authenticated",
        });
      }

      // Request pairing code from WhatsApp
      if (!session.sock?.requestPairingCode) {
        return res.status(400).json({
          ok: false,
          error: "Pairing code not supported in current state",
        });
      }

      const code = await session.sock.requestPairingCode(cleanPhone);

      res.json({
        ok: true,
        code,
        phoneNumber: cleanPhone,
        message: "Enter this code in your WhatsApp mobile app",
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Disconnect session (keeps auth state)
 * @route POST /sessions/:id/disconnect
 */
router.post(
  "/:id/disconnect",
  generalLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const session = getSession(req.params.id);

      if (session.status !== "open") {
        return res.status(400).json({
          ok: false,
          error: "Session not connected",
          status: session.status,
        });
      }

      // Close WebSocket connection
      if (session.sock?.ws) {
        session.sock.ws.close();
        session.status = "close";
      }

      res.json({
        ok: true,
        message: "Session disconnected successfully. Use /init to reconnect.",
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Restart session (reconnect)
 * @route POST /sessions/:id/restart
 */
router.post(
  "/:id/restart",
  generalLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const session = await restartSession(req.params.id);

      res.json({
        ok: true,
        message: "Session restarted successfully",
        status: session.status,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Logout and delete session (removes auth state)
 * @route POST /sessions/:id/logout
 */
router.post(
  "/:id/logout",
  authLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const { confirm } = req.body;

      // Require confirmation to prevent accidental logouts
      if (confirm !== true && confirm !== "true") {
        return res.status(400).json({
          ok: false,
          error:
            "Logout requires confirmation. Send { confirm: true } to proceed.",
          warning:
            "This will delete all session data and require re-authentication.",
        });
      }

      await logoutSession(req.params.id);

      res.json({
        ok: true,
        message: "Session logged out and deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Get session metrics
 * @route GET /sessions/:id/metrics
 */
router.get(
  "/:id/metrics",
  generalLimiter.getMiddleware(),
  async (req, res, next) => {
    try {
      const session = getSession(req.params.id);

      const metrics = {
        ok: true,
        id: session.id,
        status: session.status,
        caches: {
          messages: session.caches.messages.getStats(),
          contacts: session.caches.contacts.getStats(),
          groups: session.caches.groups.getStats(),
        },
        uptime: session.connectedAt ? Date.now() - session.connectedAt : null,
        lastActivity: session.lastActivity || null,
      };

      res.json(metrics);
    } catch (error) {
      next(error);
    }
  }
);
