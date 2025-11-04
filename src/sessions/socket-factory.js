import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { randomBytes } from "crypto";

import { sendWebhook } from "../services/webhook.js";
import {
  shouldSendEventWebhook,
  filterMessages
} from "../services/webhook-filter.js";
import { toJid } from "../utils/jid.js";
import { restartSession } from "./manager.js";
import { SHOW_QR_IN_TERMINAL } from "../config.js";
import { captureException, addBreadcrumb, setContext } from "../services/sentry.js";

function serializeBaileysData(data) {
  return JSON.parse(
    JSON.stringify(data, (key, value) => {
      if (value?.type === "Buffer" && Array.isArray(value?.data)) {
        return {
          type: "Buffer",
          data: Buffer.from(value.data).toString("base64"),
        };
      }
      if (value instanceof Buffer) {
        return {
          type: "Buffer",
          data: value.toString("base64"),
        };
      }
      if (value instanceof Uint8Array) {
        return {
          type: "Buffer",
          data: Buffer.from(value).toString("base64"),
        };
      }
      return value;
    })
  );
}

export async function makeSocketForSession(session) {
  const { state, saveCreds, caches, browser } = session;

  setContext("session", {
    id: session.id,
    status: session.status,
  });

  addBreadcrumb({
    category: "session",
    message: `Creating socket for session ${session.id}`,
    level: "info",
  });

  const { version } = await fetchLatestBaileysVersion();
  console.log(`[${session.id}] Using WA version ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys),
    },
    browser,
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
    keepAliveIntervalMs: 30000,
    cachedGroupMetadata: async (jid) => caches.groups.get(jid),
    getMessage: async (key) => {
      const m = key?.id ? caches.messages.get(key.id) : undefined;
      return m?.message;
    },
  });

  // ============================================
  // KEEP-ALIVE
  // ============================================
  const {
    KEEP_ALIVE_PING_INTERVAL,
    KEEP_ALIVE_PONG_TIMEOUT,
    KEEP_ALIVE_MAX_MISSED_PONGS,
    HEALTH_CHECK_INTERVAL: HEALTH_INTERVAL,
    MAX_IDLE_TIME,
  } = await import("../config.js");

  let keepAliveInterval;
  let healthCheckInterval;
  let lastPongReceived = Date.now();
  let missedPongs = 0;
  const MAX_MISSED_PONGS = KEEP_ALIVE_MAX_MISSED_PONGS;
  const PING_INTERVAL = KEEP_ALIVE_PING_INTERVAL;
  const HEALTH_CHECK_INTERVAL = HEALTH_INTERVAL;
  const PONG_TIMEOUT = KEEP_ALIVE_PONG_TIMEOUT;

  const startKeepAlive = () => {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    lastPongReceived = Date.now();
    missedPongs = 0;

    keepAliveInterval = setInterval(() => {
      if (session.status !== "open" || sock?.ws?.readyState !== 1) {
        return;
      }

      try {
        const timeSinceLastPong = Date.now() - lastPongReceived;

        if (timeSinceLastPong > PONG_TIMEOUT) {
          missedPongs++;
          console.warn(
            `[${session.id}] Pong timeout (${missedPongs}/${MAX_MISSED_PONGS})`
          );

          if (missedPongs >= MAX_MISSED_PONGS) {
            console.error(
              `[${session.id}] Conexão morta detectada (${MAX_MISSED_PONGS} pongs perdidos). Forçando reconexão...`
            );

            captureException(new Error("Dead connection detected"), {
              sessionId: session.id,
              missedPongs,
              timeSinceLastPong,
            });

            if (sock.ws) {
              sock.ws.close(1000, "dead connection");
            }
            return;
          }
        }

        sock.ws.ping();

        const pongHandler = () => {
          lastPongReceived = Date.now();
          missedPongs = 0;
          session.lastActivity = Date.now();
          sock.ws?.off('pong', pongHandler);
        };

        sock.ws.once('pong', pongHandler);

      } catch (e) {
        console.warn(`[${session.id}] Keep-alive ping failed:`, e.message);
        captureException(e, {
          sessionId: session.id,
          context: "keep_alive"
        });
      }
    }, PING_INTERVAL);

    healthCheckInterval = setInterval(async () => {
      if (session.status !== "open") return;

      try {
        const wsState = sock?.ws?.readyState;
        const timeSinceActivity = Date.now() - (session.lastActivity || 0);

        if (timeSinceActivity > 300000) {
          console.warn(
            `[${session.id}] Conexão estagnada detectada (${Math.round(timeSinceActivity / 1000)}s sem atividade)`
          );

          try {
            await sock.sendPresenceUpdate('available');
            session.lastActivity = Date.now();
            console.log(`[${session.id}] Health check OK - conexão respondeu`);
          } catch (err) {
            console.error(
              `[${session.id}] Health check FAILED - conexão não responde. Reconectando...`
            );

            captureException(new Error("Health check failed"), {
              sessionId: session.id,
              timeSinceActivity,
              error: err.message,
            });

            if (sock.ws) {
              sock.ws.close(1000, "health check failed");
            }
          }
        }

        if (wsState !== 1 && session.status === "open") {
          console.error(
            `[${session.id}] Inconsistência detectada: status='open' mas WebSocket não está OPEN (state=${wsState})`
          );
          session.status = "close";
        }

      } catch (e) {
        console.error(`[${session.id}] Health check error:`, e.message);
        captureException(e, {
          sessionId: session.id,
          context: "health_check"
        });
      }
    }, HEALTH_CHECK_INTERVAL);

    console.log(`[${session.id}] Keep-alive e health check iniciados`);
  };

  const stopKeepAlive = () => {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    console.log(`[${session.id}] Keep-alive e health check parados`);
  };

  session._cleanup = stopKeepAlive;

  // ============================================
  // EVENT HANDLERS
  // ============================================

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    addBreadcrumb({
      category: "connection",
      message: `Connection update for ${session.id}`,
      level: "info",
      data: {
        connection,
        hasQR: !!qr,
        isNewLogin,
      },
    });

    console.log(`[${session.id}] connection.update:`, {
      connection,
      hasQR: !!qr,
      isNewLogin,
      hasLastDisconnect: !!lastDisconnect,
    });

    if (connection) {
      session.status = connection;
      console.log(`[${session.id}] Status: ${connection}`);
    }

    if (qr) {
      console.log(`[${session.id}] QR code generated (length: ${qr.length})`);
      session.lastQR = qr;
      session.qrGeneratedAt = Date.now();

      if (SHOW_QR_IN_TERMINAL) {
        console.log(
          await QRCode.toString(qr, { type: "terminal", small: true })
        );
      }

      if (shouldSendEventWebhook("qr.updated")) {
        await sendWebhook(session.id, "qr.updated", {
          sessionId: session.id,
          qr: qr,
          generatedAt: session.qrGeneratedAt,
          expiresAt: session.qrGeneratedAt + 60000,
        });
      }
    }

    if (connection === "open") {
      session.lastQR = null;
      session.connectedAt = Date.now();
      session.lastActivity = Date.now();
      session.reconnectAttempts = 0;

      startKeepAlive();

      const accountInfo = {
        sessionId: session.id,
        status: "open",
        connectedAt: session.connectedAt,
        isNewLogin: isNewLogin || false,
        phone: state.creds?.me?.id || null,
        name: state.creds?.me?.name || null,
        platform: state.creds?.platform || null,
        deviceManufacturer: state.creds?.deviceManufacturer || null,
        deviceModel: state.creds?.deviceModel || null,
        osVersion: state.creds?.osVersion || null,
      };

      console.log(`[${session.id}] ✅ Connected:`, accountInfo);

      addBreadcrumb({
        category: "session",
        message: `Session ${session.id} connected`,
        level: "info",
        data: accountInfo,
      });

      if (shouldSendEventWebhook("session.connected")) {
        await sendWebhook(session.id, "session.connected", accountInfo);
      }
    }

    if (connection === "close") {
      stopKeepAlive();

      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error || "unknown";

      const disconnectInfo = {
        sessionId: session.id,
        status: "close",
        disconnectedAt: Date.now(),
        reason: reason,
        statusCode: code,
        isLoggedOut: code === DisconnectReason.loggedOut,
        needsReconnect: code === DisconnectReason.restartRequired,
        connectionLost: code === DisconnectReason.connectionLost,
        timedOut: code === DisconnectReason.timedOut,
      };

      console.log(`[${session.id}] ❌ Disconnected:`, disconnectInfo);

      addBreadcrumb({
        category: "session",
        message: `Session ${session.id} disconnected`,
        level: "warning",
        data: disconnectInfo,
      });

      if (code === DisconnectReason.loggedOut) {
        captureException(new Error("Session logged out"), {
          sessionId: session.id,
          reason,
          code,
        });
      }

      if (shouldSendEventWebhook("session.disconnected")) {
        await sendWebhook(session.id, "session.disconnected", disconnectInfo);
      }

      const shouldReconnect =
        code === DisconnectReason.restartRequired ||
        code === DisconnectReason.connectionLost ||
        code === DisconnectReason.timedOut ||
        code === DisconnectReason.connectionClosed ||
        code === 428;

      if (code === DisconnectReason.loggedOut) {
        console.warn(`[${session.id}] Logged out - não reconectando`);
        return;
      }

      if (shouldReconnect) {
        session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
        const maxAttempts = 10;
        const delay = Math.min(5000 * Math.pow(1.5, session.reconnectAttempts - 1), 60000);

        if (session.reconnectAttempts <= maxAttempts) {
          console.warn(
            `[${session.id}] Auto-reconectando em ${delay}ms (tentativa ${session.reconnectAttempts}/${maxAttempts})`
          );

          setTimeout(async () => {
            try {
              await restartSession(session.id);
            } catch (e) {
              console.error(`[${session.id}] Falha ao reconectar:`, e.message);
              captureException(e, {
                sessionId: session.id,
                context: "reconnect",
                attempt: session.reconnectAttempts,
              });
            }
          }, delay);
        } else {
          console.error(`[${session.id}] Máximo de tentativas atingido`);
          captureException(new Error("Max reconnection attempts reached"), {
            sessionId: session.id,
            attempts: session.reconnectAttempts,
          });
        }
        return;
      }
    }

    if (connection === "connecting") {
      console.log(`[${session.id}] 🔄 Connecting...`);
    }

    if (shouldSendEventWebhook("connection.update")) {
      await sendWebhook(
        session.id,
        "connection.update",
        serializeBaileysData(update)
      );
    }
  });

  const updateActivity = () => {
    session.lastActivity = Date.now();
  };

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (!messages?.length) return;

    updateActivity();

    for (const m of messages) {
      if (m?.key?.id) {
        caches.messages.set(m.key.id, m);
      }
      if (m?.pushName && m?.key?.remoteJid) {
        const prev = caches.contacts.get(m.key.remoteJid) || {
          id: m.key.remoteJid,
        };
        caches.contacts.set(m.key.remoteJid, { ...prev, notify: m.pushName });
      }
    }

    if (shouldSendEventWebhook("messages.upsert")) {
      const filteredMessages = filterMessages(messages);

      if (filteredMessages.length > 0) {
        await sendWebhook(
          session.id,
          "messages.upsert",
          serializeBaileysData({ type, messages: filteredMessages })
        );
      } else {
        console.log(`[${session.id}] Messages filtered out, no webhook sent`);
      }
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    updateActivity();

    if (!Array.isArray(updates)) updates = [updates];

    const processedUpdates = updates.map(update => {
      const { key, update: updateData } = update;

      return {
        key: {
          remoteJid: key.remoteJid,
          id: key.id,
          participant: key.participant,
          fromMe: key.fromMe
        },
        update: updateData,
        timestamp: new Date().toISOString()
      };
    });

    console.log(`[${session.id}] Messages updated: ${processedUpdates.length}`);

    if (shouldSendEventWebhook("messages.update")) {
      await sendWebhook(
        session.id,
        "messages.update",
        processedUpdates
      );
    }
  });

  sock.ev.on("messages.delete", async (deletion) => {
    updateActivity();
    console.log(`[${session.id}] Messages deleted`);

    if (shouldSendEventWebhook("messages.delete")) {
      await sendWebhook(
        session.id,
        "messages.delete",
        serializeBaileysData(deletion)
      );
    }
  });

  sock.ev.on("messages.reaction", async (reactions) => {
    updateActivity();

    if (shouldSendEventWebhook("messages.reaction")) {
      await sendWebhook(
        session.id,
        "messages.reaction",
        serializeBaileysData(reactions)
      );
    }
  });

  sock.ev.on("message-receipt.update", async (updates) => {
    updateActivity();

    if (!Array.isArray(updates)) updates = [updates];

    const processedUpdates = updates.map(update => {
      const { key, receipt } = update;

      return {
        key: {
          remoteJid: key.remoteJid,
          id: key.id,
          participant: key.participant,
          fromMe: key.fromMe
        },
        receipt: {
          readTimestamp: receipt?.readTimestamp
            ? new Date(receipt.readTimestamp * 1000).toISOString()
            : null,
          deliveredTimestamp: receipt?.deliveredTimestamp
            ? new Date(receipt.deliveredTimestamp * 1000).toISOString()
            : null,
          playedTimestamp: receipt?.playedTimestamp
            ? new Date(receipt.playedTimestamp * 1000).toISOString()
            : null,
          userJid: receipt?.userJid,
        },
        timestamp: new Date().toISOString()
      };
    });

    if (shouldSendEventWebhook("message-receipt.update")) {
      await sendWebhook(
        session.id,
        "message-receipt.update",
        processedUpdates
      );
    }
  });

  sock.ev.on("chats.upsert", async (chats) => {
    updateActivity();

    if (shouldSendEventWebhook("chats.upsert")) {
      await sendWebhook(
        session.id,
        "chats.upsert",
        serializeBaileysData(chats)
      );
    }
  });

  sock.ev.on("chats.update", async (updates) => {
    updateActivity();

    if (shouldSendEventWebhook("chats.update")) {
      await sendWebhook(
        session.id,
        "chats.update",
        serializeBaileysData(updates)
      );
    }
  });

  sock.ev.on("chats.delete", async (deletions) => {
    updateActivity();

    if (shouldSendEventWebhook("chats.delete")) {
      await sendWebhook(
        session.id,
        "chats.delete",
        serializeBaileysData(deletions)
      );
    }
  });

  sock.ev.on("contacts.upsert", async (contacts) => {
    updateActivity();
    contacts?.forEach((c) => c?.id && caches.contacts.set(c.id, c));

    if (shouldSendEventWebhook("contacts.upsert")) {
      await sendWebhook(
        session.id,
        "contacts.upsert",
        serializeBaileysData(contacts)
      );
    }
  });

  sock.ev.on("contacts.update", async (updates) => {
    updateActivity();

    updates?.forEach(
      (c) =>
        c?.id &&
        caches.contacts.set(c.id, {
          ...(caches.contacts.get(c.id) || {}),
          ...c,
        })
    );

    if (shouldSendEventWebhook("contacts.update")) {
      await sendWebhook(
        session.id,
        "contacts.update",
        serializeBaileysData(updates)
      );
    }
  });

  sock.ev.on("groups.upsert", async (groups) => {
    updateActivity();
    groups?.forEach((g) => g?.id && caches.groups.set(g.id, g));

    if (shouldSendEventWebhook("groups.upsert")) {
      await sendWebhook(
        session.id,
        "groups.upsert",
        serializeBaileysData(groups)
      );
    }
  });

  sock.ev.on("groups.update", async (updates) => {
    updateActivity();

    updates?.forEach(
      (g) =>
        g?.id &&
        caches.groups.set(g.id, {
          ...(caches.groups.get(g.id) || {}),
          ...g,
        })
    );

    if (shouldSendEventWebhook("groups.update")) {
      await sendWebhook(
        session.id,
        "groups.update",
        serializeBaileysData(updates)
      );
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    updateActivity();

    if (shouldSendEventWebhook("group-participants.update")) {
      await sendWebhook(
        session.id,
        "group-participants.update",
        serializeBaileysData(update)
      );
    }
  });

  sock.ev.on("messaging-history.set", async (history) => {
    updateActivity();

    if (history?.contacts?.length) {
      history.contacts.forEach((c) => c?.id && caches.contacts.set(c.id, c));
    }

    console.log(`[${session.id}] History synced:`, {
      chats: history?.chats?.length || 0,
      contacts: history?.contacts?.length || 0,
      messages: history?.messages?.length || 0,
      isLatest: history?.isLatest
    });

    if (shouldSendEventWebhook("messaging-history.set")) {
      await sendWebhook(
        session.id,
        "messaging-history.set",
        serializeBaileysData(history)
      );
    }
  });

  sock.ev.on("presence.update", async (update) => {
    updateActivity();

    if (shouldSendEventWebhook("presence.update")) {
      await sendWebhook(
        session.id,
        "presence.update",
        serializeBaileysData(update)
      );
    }
  });

  sock.ev.on("call", async (calls) => {
    updateActivity();

    if (shouldSendEventWebhook("call")) {
      await sendWebhook(
        session.id,
        "call",
        serializeBaileysData(calls)
      );
    }
  });

  sock.ev.on("blocklist.set", async (blocklist) => {
    updateActivity();

    if (shouldSendEventWebhook("blocklist.set")) {
      await sendWebhook(
        session.id,
        "blocklist.set",
        serializeBaileysData(blocklist)
      );
    }
  });

  sock.ev.on("blocklist.update", async (update) => {
    updateActivity();

    if (shouldSendEventWebhook("blocklist.update")) {
      await sendWebhook(
        session.id,
        "blocklist.update",
        serializeBaileysData(update)
      );
    }
  });

  // ============================================
  // CUSTOM METHODS
  // ============================================

  sock.__send = async (payload = {}) => {
    try {
      const {
        to,
        type,
        text,
        caption,
        url,
        base64,
        mimetype,
        fileName,
        ptt,
        gifPlayback,
        viewOnce,
        quality,
        quoted,
        quotedId,
        mentions,
        poll,
        contacts,
        location,
        options = {},
      } = payload;

      const jid = toJid(to);
      const sendOpts = { ...(options || {}) };

      if (quoted) {
        sendOpts.quoted = quoted;
      } else if (quotedId) {
        const q = session.caches.messages.get(quotedId);
        if (q) sendOpts.quoted = q;
      }

      const mentionedJid = Array.isArray(mentions)
        ? mentions.map((m) =>
          /@/.test(m) ? m : `${String(m).replace(/\D/g, "")}@s.whatsapp.net`
        )
        : undefined;

      const media = base64
        ? Buffer.from(base64, "base64")
        : url
          ? { url }
          : undefined;

      let content;

      switch (type) {
        case "text":
          content = { text };
          break;

        case "image": {
          const sendAsDocument = quality === "hd" || quality === "original";
          content = sendAsDocument
            ? {
              document: media,
              mimetype: mimetype || "image/jpeg",
              fileName: fileName || "image.jpg",
            }
            : { image: media, caption, mimetype };
          if (viewOnce) content.viewOnce = true;
          break;
        }

        case "video": {
          const sendAsDocument = quality === "hd" || quality === "original";
          content = sendAsDocument
            ? {
              document: media,
              mimetype: mimetype || "video/mp4",
              fileName: fileName || "video.mp4",
            }
            : { video: media, caption, mimetype, gifPlayback: !!gifPlayback };
          if (viewOnce) content.viewOnce = true;
          break;
        }

        case "audio":
          content = {
            audio: media,
            ptt: !!ptt,
            mimetype: mimetype || (ptt ? "audio/ogg; codecs=opus" : undefined),
          };
          break;

        case "document":
          content = { document: media, mimetype, fileName };
          break;

        case "sticker":
          content = { sticker: media, mimetype: mimetype || "image/webp" };
          break;

        case "contacts": {
          let displayName = contacts?.displayName || "Contact";
          let arr = [];
          if (Array.isArray(contacts?.vcards)) {
            arr = contacts.vcards.map((v) => ({ vcard: v }));
          } else if (Array.isArray(contacts?.contacts)) {
            arr = contacts.contacts.map((c) => ({ vcard: c.vcard }));
          }
          content = { contacts: { displayName, contacts: arr } };
          break;
        }

        case "poll": {
          let messageSecret = poll?.messageSecretB64
            ? Buffer.from(poll.messageSecretB64, "base64")
            : randomBytes(32);
          content = {
            poll: {
              name: poll?.name,
              values: poll?.values || [],
              selectableCount: poll?.selectableCount,
              messageSecret,
            },
          };
          break;
        }

        case "location":
          content = {
            location: {
              degreesLatitude: Number(location?.latitude),
              degreesLongitude: Number(location?.longitude),
              name: location?.name,
              address: location?.address,
            },
          };
          break;

        default:
          if (payload.content) {
            content = payload.content;
          } else {
            throw new Error(`Unsupported message type: ${type}`);
          }
      }

      if (mentionedJid?.length) {
        content.contextInfo = { ...(content.contextInfo || {}), mentionedJid };
      }

      updateActivity();

      addBreadcrumb({
        category: "message",
        message: `Sending ${type} message`,
        level: "info",
        data: { to: jid, type },
      });

      return await sock.sendMessage(jid, content, sendOpts);
    } catch (error) {
      captureException(error, {
        sessionId: session.id,
        context: "send_message",
        messageType: payload.type,
      });
      throw error;
    }
  };

  sock.__download = async (wamessage) => {
    try {
      updateActivity();
      const buffer = await downloadMediaMessage(wamessage, "buffer");
      return buffer;
    } catch (error) {
      captureException(error, {
        sessionId: session.id,
        context: "download_media",
      });
      throw error;
    }
  };

  sock.__read = async (keys) => {
    updateActivity();
    return sock.readMessages(keys);
  };

  sock.__receipt = async (jid, participant, ids, type) => {
    updateActivity();
    return sock.sendReceipt(jid, participant, ids, type);
  };

  sock.__contactInfo = async (id, cachesRef = caches) => {
    updateActivity();

    const jid = toJid(id);
    let profilePictureUrl;
    try {
      profilePictureUrl = await sock.profilePictureUrl(jid, "image");
    } catch { }
    const cached = cachesRef.contacts.get(jid);
    return {
      id: jid,
      name: cached?.name || cached?.notify || null,
      profilePictureUrl: profilePictureUrl || null,
    };
  };

  sock.__typing = async (to, state = "composing") => {
    updateActivity();
    const jid = toJid(to);
    await sock.sendPresenceUpdate(state, jid);
  };

  return sock;
}