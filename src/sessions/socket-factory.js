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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    console.log(`[${session.id}] Connection update:`, {
      connection,
      hasQR: !!qr,
      qrLength: qr?.length,
    });

    session.status = connection || "close";

    if (qr) {
      console.log(`[${session.id}] 🎯 QR CODE GENERATED! Length: ${qr.length}`);

      session.lastQR = qr;
      session.qrGeneratedAt = Date.now();

      if (SHOW_QR_IN_TERMINAL) {
        console.log(
          await QRCode.toString(qr, { type: "terminal", small: true })
        );
      }

      if (shouldSendEventWebhook("qr.updated")) {
        await sendWebhook(
          session.id,
          "qr.updated",
          {
            sessionId: session.id,
            qr: qr,
            generatedAt: session.qrGeneratedAt,
            expiresAt: session.qrGeneratedAt + 60000,
          }
        );
      }
    }

    if (connection === "open") {
      session.lastQR = null;
      session.connectedAt = Date.now();
      session.lastActivity = Date.now();

      const accountInfo = {
        sessionId: session.id,
        status: "open",
        connectedAt: session.connectedAt,
        phone: state.creds?.me?.id || null,
        name: state.creds?.me?.name || null,
        platform: state.creds?.platform || null,
        deviceManufacturer: state.creds?.deviceManufacturer || null,
        deviceModel: state.creds?.deviceModel || null,
        osVersion: state.creds?.osVersion || null,
      };

      console.log(`[${session.id}] ✅ Session connected successfully:`, accountInfo);

      if (shouldSendEventWebhook("session.connected")) {
        await sendWebhook(
          session.id,
          "session.connected",
          accountInfo
        );
      }
    }

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

      console.log(`[${session.id}] ❌ Session disconnected:`, disconnectInfo);

      if (shouldSendEventWebhook("session.disconnected")) {
        await sendWebhook(
          session.id,
          "session.disconnected",
          disconnectInfo
        );
      }

      if (code === DisconnectReason.restartRequired) {
        console.warn(`[${session.id}] restartRequired (515) — restarting session`);
        await restartSession(session.id);
        return;
      }
    }

    if (shouldSendEventWebhook("connection.update")) {
      await sendWebhook(
        session.id,
        "connection.update",
        serializeBaileysData(update)
      );
    }
  });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (!messages?.length) return;

    session.lastActivity = Date.now();

    for (const m of messages) {
      if (m?.key?.id) caches.messages.set(m.key.id, m);
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
        console.log(`[${session.id}] All messages filtered out, webhook not sent`);
      }
    }
  });

  sock.ev.on("message-receipt.update", async (updates) => {
    if (!Array.isArray(updates)) updates = [updates];

    const processedUpdates = updates.map(update => {
      const { key, receipt } = update;
      const timestamp = new Date().toISOString();

      const processed = {
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
        timestamp
      };

      console.log(`[${session.id}] Receipt update for message ${key.id}:`, processed.receipt);

      return processed;
    });

    if (shouldSendEventWebhook("message-receipt.update")) {
      await sendWebhook(
        session.id,
        "message-receipt.update",
        processedUpdates
      );
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    if (!Array.isArray(updates)) updates = [updates];

    const processedUpdates = updates.map(update => {
      const { key, update: updateData } = update;
      const statusCode = updateData?.status;
      const timestamp = new Date().toISOString();

      const processed = {
        key: {
          remoteJid: key.remoteJid,
          id: key.id,
          participant: key.participant,
          fromMe: key.fromMe
        },
        update: {
          statusCode: statusCode,
          timestamp
        }
      };

      console.log(`[${session.id}] Status update for message ${key.id}: statusCode=${statusCode}`);

      return processed;
    });

    if (shouldSendEventWebhook("messages.update")) {
      await sendWebhook(
        session.id,
        "messages.update",
        processedUpdates
      );
    }
  });

  sock.ev.on("messages.reaction", async (reactions) => {
    if (shouldSendEventWebhook("messages.reaction")) {
      await sendWebhook(
        session.id,
        "messages.reaction",
        serializeBaileysData(reactions)
      );
    }
  });

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

  sock.ev.on("messaging-history.set", async (history) => {
    if (history?.contacts?.length) {
      history.contacts.forEach((c) => c?.id && caches.contacts.set(c.id, c));
    }

    if (shouldSendEventWebhook("messaging-history.set")) {
      await sendWebhook(
        session.id,
        "messaging-history.set",
        serializeBaileysData(history)
      );
    }
  });

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

  sock.ev.on("group-participants.update", async (update) => {
    if (shouldSendEventWebhook("group-participants.update")) {
      await sendWebhook(
        session.id,
        "group-participants.update",
        serializeBaileysData(update)
      );
    }
  });

  sock.ev.on("presence.update", async (update) => {
    if (shouldSendEventWebhook("presence.update")) {
      await sendWebhook(
        session.id,
        "presence.update",
        serializeBaileysData(update)
      );
    }
  });

  sock.ev.on("chats.upsert", async (chats) => {
    if (shouldSendEventWebhook("chats.upsert")) {
      await sendWebhook(session.id, "chats.upsert", serializeBaileysData(chats));
    }
  });

  sock.ev.on("chats.update", async (updates) => {
    if (shouldSendEventWebhook("chats.update")) {
      await sendWebhook(
        session.id,
        "chats.update",
        serializeBaileysData(updates)
      );
    }
  });

  sock.ev.on("chats.delete", async (deletions) => {
    if (shouldSendEventWebhook("chats.delete")) {
      await sendWebhook(
        session.id,
        "chats.delete",
        serializeBaileysData(deletions)
      );
    }
  });

  sock.ev.on("messages.delete", async (deletions) => {
    if (shouldSendEventWebhook("messages.delete")) {
      await sendWebhook(
        session.id,
        "messages.delete",
        serializeBaileysData(deletions)
      );
    }
  });

  sock.ev.on("call", async (calls) => {
    if (shouldSendEventWebhook("call")) {
      await sendWebhook(session.id, "call", serializeBaileysData(calls));
    }
  });

  sock.ev.on("blocklist.update", async (update) => {
    if (shouldSendEventWebhook("blocklist.update")) {
      await sendWebhook(
        session.id,
        "blocklist.update",
        serializeBaileysData(update)
      );
    }
  });

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

    if (quoted) sendOpts.quoted = quoted;
    else if (quotedId) {
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
          throw new Error(`Unsupported type: ${type}`);
        }
    }

    if (mentionedJid?.length) {
      content.contextInfo = { ...(content.contextInfo || {}), mentionedJid };
    }

    session.lastActivity = Date.now();

    return await sock.sendMessage(jid, content, sendOpts);
  };

  sock.__download = async (wamessage) => {
    const buffer = await downloadMediaMessage(wamessage, "buffer");
    return buffer;
  };

  sock.__read = async (keys) => sock.readMessages(keys);

  sock.__receipt = async (jid, participant, ids, type) =>
    sock.sendReceipt(jid, participant, ids, type);

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

  sock.__typing = async (to, state = "composing") => {
    const jid = toJid(to);
    await sock.sendPresenceUpdate(state, jid);
  };

  return sock;
}