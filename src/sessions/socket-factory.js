import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { sendWebhook } from "../webhook.js";
import { toJid } from "../utils/jid.js";
import { restartSession } from "./manager.js";
import { SHOW_QR_IN_TERMINAL } from "../config.js";

// create socket, register listeners and return the sock
export async function makeSocketForSession(session) {
  const { state, saveCreds, caches, browser } = session;

  const sock = makeWASocket({
    auth: state,
    browser,
    cachedGroupMetadata: async (jid) => caches.groups.get(jid),
    // getMessage is important for re-send/decryption (polls etc.) :contentReference[oaicite:11]{index=11}
    getMessage: async (key) => {
      const m = key?.id ? caches.messages.get(key.id) : undefined;
      return m?.message;
    },
  });

  sock.ev.on("creds.update", saveCreds);

  // connection.update (restarts on 515 — restartRequired) :contentReference[oaicite:12]{index=12}
  sock.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      session.status = connection || "close";
      if (qr) {
        session.lastQR = qr;
        if (SHOW_QR_IN_TERMINAL) {
          console.log(
            await QRCode.toString(qr, { type: "terminal", small: true })
          );
        }
      }
      if (connection === "open") session.lastQR = null;

      const code = lastDisconnect?.error?.output?.statusCode;
      if (connection === "close" && code === DisconnectReason.restartRequired) {
        console.warn(
          `[${session.id}] restartRequired (515) — restarting session`
        );
        await restartSession(session.id);
        return;
      }
      await sendWebhook(session.id, "connection.update", {
        connection,
        hasQR: !!qr,
      });
    }
  );

  // messages.upsert (handle ALL items in the array) :contentReference[oaicite:13]{index=13}
  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (!messages?.length) return;
    for (const m of messages) {
      if (m?.key?.id) caches.messages.set(m.key.id, m);
      if (m?.pushName && m?.key?.remoteJid) {
        const prev = caches.contacts.get(m.key.remoteJid) || {
          id: m.key.remoteJid,
        };
        caches.contacts.set(m.key.remoteJid, { ...prev, notify: m.pushName });
      }
    }
    await sendWebhook(session.id, "messages.upsert", { type, messages });
  });

  // other useful events
  sock.ev.on("message-receipt.update", async (u) =>
    sendWebhook(session.id, "message-receipt.update", u)
  );
  sock.ev.on("messages.update", async (u) =>
    sendWebhook(session.id, "messages.update", u)
  );
  sock.ev.on("messages.reaction", async (u) =>
    sendWebhook(session.id, "messages.reaction", u)
  );
  sock.ev.on("contacts.upsert", async (u) => {
    u?.forEach((c) => c?.id && caches.contacts.set(c.id, c));
    await sendWebhook(session.id, "contacts.upsert", u);
  });
  sock.ev.on("contacts.update", async (u) => {
    u?.forEach(
      (c) =>
        c?.id &&
        caches.contacts.set(c.id, {
          ...(caches.contacts.get(c.id) || {}),
          ...c,
        })
    );
    await sendWebhook(session.id, "contacts.update", u);
  });
  sock.ev.on("messaging-history.set", async (hist) => {
    if (hist?.contacts?.length)
      hist.contacts.forEach((c) => c?.id && caches.contacts.set(c.id, c));
    await sendWebhook(session.id, "messaging-history.set", {
      syncType: hist?.syncType,
    });
  });

  // send/ack/media helpers exposed on the instance (makes routes easier)
  sock.__sendText = async (to, text, { quoted, quotedId, options } = {}) => {
    const jid = toJid(to);
    const sendOpts = { ...(options || {}) };
    if (quoted) sendOpts.quoted = quoted;
    else if (quotedId) {
      const q = caches.messages.get(quotedId);
      if (q) sendOpts.quoted = q;
    }
    return sock.sendMessage(jid, { text }, sendOpts); // default send :contentReference[oaicite:14]{index=14}
  };

  sock.__sendMedia = async ({
    to,
    kind,
    url,
    base64,
    caption,
    mimetype,
    fileName,
    ptt,
  }) => {
    const jid = toJid(to);
    const data = base64 ? Buffer.from(base64, "base64") : undefined;
    let content;
    if (kind === "image") content = { image: url ? { url } : data, caption };
    else if (kind === "audio")
      content = { audio: url ? { url } : data, ptt: !!ptt, mimetype };
    else if (kind === "video")
      content = { video: url ? { url } : data, caption, mimetype };
    else if (kind === "document")
      content = { document: url ? { url } : data, fileName, mimetype };
    else throw new Error("invalid kind");
    return sock.sendMessage(jid, content);
  };

  sock.__download = async (wamessage) => {
    const buffer = await downloadMediaMessage(wamessage, "buffer");
    return buffer;
  };

  sock.__read = async (keys) => sock.readMessages(keys); // read :contentReference[oaicite:15]{index=15}
  sock.__receipt = async (jid, participant, ids, type) =>
    sock.sendReceipt(jid, participant, ids, type); // generic receipt :contentReference[oaicite:16]{index=16}
  sock.__contactInfo = async (id, cachesRef = caches) => {
    const jid = toJid(id);
    let profilePictureUrl;
    try {
      profilePictureUrl = await sock.profilePictureUrl(jid, "image");
    } catch {}
    const cached = cachesRef.contacts.get(jid);
    return {
      id: jid,
      name: cached?.name || cached?.notify || null,
      profilePictureUrl: profilePictureUrl || null,
    };
  };

  return sock;
}
