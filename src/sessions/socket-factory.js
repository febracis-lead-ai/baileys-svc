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
  shouldSendMessageWebhook,
  shouldSendEventWebhook,
  filterMessages
} from "../services/webhook-filter.js";
import { toJid } from "../utils/jid.js";
import { restartSession } from "./manager.js";
import { SHOW_QR_IN_TERMINAL } from "../config.js";

/**
 * Serialize Baileys data to JSON-safe format
 * Handles Buffer, Uint8Array conversions
 */
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

/**
 * Create a WhatsApp socket for a session
 * Follows Baileys v7.0.0-rc.6 standards
 */
export async function makeSocketForSession(session) {
  const { state, saveCreds, caches, browser } = session;

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
    cachedGroupMetadata: async (jid) => caches.groups.get(jid),
    getMessage: async (key) => {
      const m = key?.id ? caches.messages.get(key.id) : undefined;
      return m?.message;
    },
  });

  // ===========================================
  // AUTHENTICATION & CONNECTION EVENTS
  // ===========================================

  /**
   * Event: creds.update
   * Triggered when authentication credentials are updated
   * CRITICAL: Must save credentials to prevent message delivery failures
   */
  sock.ev.on("creds.update", saveCreds);

  /**
   * Event: connection.update
   * Source of truth for connection status according to Baileys docs
   * Values: "open" | "connecting" | "close"
   * 
   * Reference: https://baileys.wiki/docs/socket/connecting/
   */
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    console.log(`[${session.id}] connection.update:`, {
      connection,
      hasQR: !!qr,
      isNewLogin,
      hasLastDisconnect: !!lastDisconnect,
    });

    // Update session status based on connection field
    if (connection) {
      session.status = connection;
      console.log(`[${session.id}] Status: ${connection}`);
    }

    // Handle QR code generation
    if (qr) {
      console.log(`[${session.id}] QR code generated (length: ${qr.length})`);

      session.lastQR = qr;
      session.qrGeneratedAt = Date.now();

      if (SHOW_QR_IN_TERMINAL) {
        console.log(
          await QRCode.toString(qr, { type: "terminal", small: true })
        );
      }

      // Send QR webhook
      if (shouldSendEventWebhook("qr.updated")) {
        await sendWebhook(session.id, "qr.updated", {
          sessionId: session.id,
          qr: qr,
          generatedAt: session.qrGeneratedAt,
          expiresAt: session.qrGeneratedAt + 60000,
        });
      }
    }

    // Handle successful connection
    if (connection === "open") {
      session.lastQR = null;
      session.connectedAt = Date.now();
      session.lastActivity = Date.now();

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

      if (shouldSendEventWebhook("session.connected")) {
        await sendWebhook(session.id, "session.connected", accountInfo);
      }
    }

    // Handle disconnection
    if (connection === "close") {
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

      if (shouldSendEventWebhook("session.disconnected")) {
        await sendWebhook(session.id, "session.disconnected", disconnectInfo);
      }

      // Auto-restart if required by WhatsApp
      if (code === DisconnectReason.restartRequired) {
        console.warn(`[${session.id}] Restart required, restarting...`);
        await restartSession(session.id);
        return;
      }
    }

    // Handle connecting state
    if (connection === "connecting") {
      console.log(`[${session.id}] 🔄 Connecting...`);
    }

    // Send raw connection update webhook
    if (shouldSendEventWebhook("connection.update")) {
      await sendWebhook(
        session.id,
        "connection.update",
        serializeBaileysData(update)
      );
    }
  });

  // ===========================================
  // MESSAGE EVENTS
  // ===========================================

  /**
   * Event: messages.upsert
   * New messages received (notify) or old messages synced (append)
   * 
   * Reference: https://baileys.wiki/docs/socket/receiving-updates/
   */
  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (!messages?.length) return;

    session.lastActivity = Date.now();

    // Cache messages and contact names
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

    // Send webhook with filtered messages
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

  /**
   * Event: messages.update
   * Message status updates (edited, deleted, receipt changes)
   */
  sock.ev.on("messages.update", async (updates) => {
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

  /**
   * Event: messages.delete
   * Messages were deleted
   */
  sock.ev.on("messages.delete", async (deletion) => {
    console.log(`[${session.id}] Messages deleted`);

    if (shouldSendEventWebhook("messages.delete")) {
      await sendWebhook(
        session.id,
        "messages.delete",
        serializeBaileysData(deletion)
      );
    }
  });

  /**
   * Event: messages.reaction
   * Reactions added or removed from messages
   */
  sock.ev.on("messages.reaction", async (reactions) => {
    if (shouldSendEventWebhook("messages.reaction")) {
      await sendWebhook(
        session.id,
        "messages.reaction",
        serializeBaileysData(reactions)
      );
    }
  });

  /**
   * Event: message-receipt.update
   * Read/delivered/played receipts in groups and chats
   */
  sock.ev.on("message-receipt.update", async (updates) => {
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

  // ===========================================
  // CHAT EVENTS
  // ===========================================

  /**
   * Event: chats.upsert
   * New chats opened
   */
  sock.ev.on("chats.upsert", async (chats) => {
    if (shouldSendEventWebhook("chats.upsert")) {
      await sendWebhook(
        session.id,
        "chats.upsert",
        serializeBaileysData(chats)
      );
    }
  });

  /**
   * Event: chats.update
   * Chat metadata updated (unread count, last message, etc.)
   */
  sock.ev.on("chats.update", async (updates) => {
    if (shouldSendEventWebhook("chats.update")) {
      await sendWebhook(
        session.id,
        "chats.update",
        serializeBaileysData(updates)
      );
    }
  });

  /**
   * Event: chats.delete
   * Chats deleted
   */
  sock.ev.on("chats.delete", async (deletions) => {
    if (shouldSendEventWebhook("chats.delete")) {
      await sendWebhook(
        session.id,
        "chats.delete",
        serializeBaileysData(deletions)
      );
    }
  });

  // ===========================================
  // CONTACT EVENTS
  // ===========================================

  /**
   * Event: contacts.upsert
   * New contacts added
   */
  sock.ev.on("contacts.upsert", async (contacts) => {
    contacts?.forEach((c) => c?.id && caches.contacts.set(c.id, c));

    if (shouldSendEventWebhook("contacts.upsert")) {
      await sendWebhook(
        session.id,
        "contacts.upsert",
        serializeBaileysData(contacts)
      );
    }
  });

  /**
   * Event: contacts.update
   * Contact details changed
   */
  sock.ev.on("contacts.update", async (updates) => {
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

  // ===========================================
  // GROUP EVENTS
  // ===========================================

  /**
   * Event: groups.upsert
   * Joined new groups
   */
  sock.ev.on("groups.upsert", async (groups) => {
    groups?.forEach((g) => g?.id && caches.groups.set(g.id, g));

    if (shouldSendEventWebhook("groups.upsert")) {
      await sendWebhook(
        session.id,
        "groups.upsert",
        serializeBaileysData(groups)
      );
    }
  });

  /**
   * Event: groups.update
   * Group metadata changed
   */
  sock.ev.on("groups.update", async (updates) => {
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

  /**
   * Event: group-participants.update
   * Group participants added/removed or permissions changed
   */
  sock.ev.on("group-participants.update", async (update) => {
    if (shouldSendEventWebhook("group-participants.update")) {
      await sendWebhook(
        session.id,
        "group-participants.update",
        serializeBaileysData(update)
      );
    }
  });

  // ===========================================
  // HISTORY & PRESENCE EVENTS
  // ===========================================

  /**
   * Event: messaging-history.set
   * Historical messages synced (NOT messaging.history-set)
   * This is the correct event name according to Baileys v7
   */
  sock.ev.on("messaging-history.set", async (history) => {
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

  /**
   * Event: presence.update
   * Contact presence status changed (online, offline, typing, etc.)
   */
  sock.ev.on("presence.update", async (update) => {
    if (shouldSendEventWebhook("presence.update")) {
      await sendWebhook(
        session.id,
        "presence.update",
        serializeBaileysData(update)
      );
    }
  });

  // ===========================================
  // OTHER EVENTS
  // ===========================================

  /**
   * Event: call
   * Universal event for call data (accept/decline/offer/timeout)
   */
  sock.ev.on("call", async (calls) => {
    if (shouldSendEventWebhook("call")) {
      await sendWebhook(
        session.id,
        "call",
        serializeBaileysData(calls)
      );
    }
  });

  /**
   * Event: blocklist.set
   * Initial blocklist received
   */
  sock.ev.on("blocklist.set", async (blocklist) => {
    if (shouldSendEventWebhook("blocklist.set")) {
      await sendWebhook(
        session.id,
        "blocklist.set",
        serializeBaileysData(blocklist)
      );
    }
  });

  /**
   * Event: blocklist.update
   * Blocklist changed
   */
  sock.ev.on("blocklist.update", async (update) => {
    if (shouldSendEventWebhook("blocklist.update")) {
      await sendWebhook(
        session.id,
        "blocklist.update",
        serializeBaileysData(update)
      );
    }
  });

  // ===========================================
  // HELPER METHODS
  // ===========================================

  /**
   * Send message helper
   * Handles all message types with proper formatting
   */
  sock.__send = async (payload = {}) => {
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

    // Handle quoted messages
    if (quoted) {
      sendOpts.quoted = quoted;
    } else if (quotedId) {
      const q = session.caches.messages.get(quotedId);
      if (q) sendOpts.quoted = q;
    }

    // Handle mentions
    const mentionedJid = Array.isArray(mentions)
      ? mentions.map((m) =>
        /@/.test(m) ? m : `${String(m).replace(/\D/g, "")}@s.whatsapp.net`
      )
      : undefined;

    // Handle media
    const media = base64
      ? Buffer.from(base64, "base64")
      : url
        ? { url }
        : undefined;

    let content;

    // Build message content based on type
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

    // Add mentions to context
    if (mentionedJid?.length) {
      content.contextInfo = { ...(content.contextInfo || {}), mentionedJid };
    }

    session.lastActivity = Date.now();

    return await sock.sendMessage(jid, content, sendOpts);
  };

  /**
   * Download media helper
   */
  sock.__download = async (wamessage) => {
    const buffer = await downloadMediaMessage(wamessage, "buffer");
    return buffer;
  };

  /**
   * Mark messages as read
   */
  sock.__read = async (keys) => sock.readMessages(keys);

  /**
   * Send message receipt (delivered, read, etc.)
   */
  sock.__receipt = async (jid, participant, ids, type) =>
    sock.sendReceipt(jid, participant, ids, type);

  /**
   * Get contact info with profile picture
   */
  sock.__contactInfo = async (id, cachesRef = caches) => {
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

  /**
   * Send presence update (typing, recording, etc.)
   */
  sock.__typing = async (to, state = "composing") => {
    const jid = toJid(to);
    await sock.sendPresenceUpdate(state, jid);
  };

  return sock;
}