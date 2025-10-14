import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { randomBytes } from "crypto";

import { sendWebhook } from "../services/webhook.js";
import { toJid } from "../utils/jid.js";
import { restartSession } from "./manager.js";
import { SHOW_QR_IN_TERMINAL } from "../config.js";

// create socket, register listeners and return the sock
export async function makeSocketForSession(session) {
  const { state, saveCreds, caches, browser } = session;

  const { version } = await fetchLatestBaileysVersion();
  console.log(`[${session.id}] Using WA version ${version.join(".")}`);

  const sock = makeWASocket({
    version, // ← ADICIONAR
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys), // ← MODIFICAR
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

  // connection.update (restarts on 515 — restartRequired) :contentReference[oaicite:12]{index=12}
  sock.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      console.log(`[${session.id}] Connection update:`, {
        connection,
        hasQR: !!qr,
        qrLength: qr?.length,
      });

      session.status = connection || "close";

      if (qr) {
        console.log(
          `[${session.id}] 🎯 QR CODE GENERATED! Length: ${qr.length}`
        );

        session.lastQR = qr;
        session.qrGeneratedAt = Date.now();
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

  sock.__send = async (payload = {}) => {
    const {
      to,
      type, // 'text'|'image'|'video'|'audio'|'document'|'sticker'|'poll'|'contacts'|'location'
      text,
      caption,
      url, // for media (mutually exclusive with base64)
      base64, // for media (mutually exclusive with url)
      mimetype,
      fileName,
      ptt, // voice note (audio) if true
      gifPlayback, // autoplay-loop for short mp4s
      viewOnce, // photo/video (and most media) can be view-once
      quality, // 'standard' | 'hd' | 'original' (see note below)
      quoted, // full WAMessage to reply to (optional)
      quotedId, // or just the message ID we cached
      mentions, // array of JIDs or phone numbers to @ mention
      // complex kinds:
      poll, // { name, values: string[], selectableCount?, messageSecretB64? }
      contacts, // { displayName?, vcards: string[] }  OR  { displayName?, contacts: [{ vcard }] }
      location, // { latitude, longitude, name?, address? }
      // pass-through for any Baileys options (e.g., scheduling, ephemeralExpiration, etc.)
      options = {},
    } = payload;

    const jid = toJid(to);
    const sendOpts = { ...(options || {}) };

    // quoted: allow either a cached id or the full message
    if (quoted) sendOpts.quoted = quoted;
    else if (quotedId) {
      const q = session.caches.messages.get(quotedId);
      if (q) sendOpts.quoted = q;
    }

    // @mentions -> contextInfo.mentionedJid (normalize numbers into JIDs)
    const mentionedJid = Array.isArray(mentions)
      ? mentions.map((m) =>
          /@/.test(m) ? m : `${String(m).replace(/\D/g, "")}@s.whatsapp.net`
        )
      : undefined;

    // media source
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
        // NOTE on "HD/original": WhatsApp UI has an HD toggle, but Baileys does not expose
        // a documented flag. To preserve highest quality reliably, send the image as a
        // *document* (no re-encoding by WA), keeping the correct mimetype/filename.
        // See explanation below.
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
          // Voice notes work best as OGG/Opus when ptt=true
          mimetype: mimetype || (ptt ? "audio/ogg; codecs=opus" : undefined),
        };
        break;

      case "document":
        content = { document: media, mimetype, fileName };
        break;

      case "sticker":
        // Stickers are typically WEBP. You must convert beforehand if you start from PNG/JPG.
        content = { sticker: media, mimetype: mimetype || "image/webp" };
        break;

      case "contacts": {
        // Accept { displayName?, vcards:[] } OR { displayName?, contacts:[{vcard}] }
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
        // PollMessageOptions: { name, values, selectableCount?, messageSecret? }
        let messageSecret = poll?.messageSecretB64
          ? Buffer.from(poll.messageSecretB64, "base64")
          : randomBytes(32); // generate one if not provided
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
        // Escape hatch: allow raw Baileys content (advanced/edge cases)
        if (payload.content) {
          content = payload.content;
        } else {
          throw new Error(`Unsupported type: ${type}`);
        }
    }

    if (mentionedJid?.length) {
      content.contextInfo = { ...(content.contextInfo || {}), mentionedJid };
    }

    return await sock.sendMessage(jid, content, sendOpts);
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
