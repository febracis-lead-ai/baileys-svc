/**
 * Webhook Filtering System for Baileys v7.0.0-rc.6
 * 
 * Controls which messages/events trigger webhooks based on configuration.
 * Follows Baileys official event naming and structure.
 * 
 * Reference: https://baileys.wiki/docs/socket/receiving-updates/
 */

// ============================================
// CONFIGURATION
// ============================================

const FILTERS = {
    // Skip broadcast/status messages
    skipStatus: process.env.WEBHOOK_SKIP_STATUS !== "false",

    // Skip group messages
    skipGroups: process.env.WEBHOOK_SKIP_GROUPS === "true",

    // Skip channel/newsletter messages
    skipChannels: process.env.WEBHOOK_SKIP_CHANNELS !== "false",

    // Skip messages from blocked contacts
    skipBlocked: process.env.WEBHOOK_SKIP_BLOCKED === "true",

    // Only send specific events (comma-separated, empty = all events)
    allowedEvents: process.env.WEBHOOK_ALLOWED_EVENTS
        ? process.env.WEBHOOK_ALLOWED_EVENTS.split(",").map(e => e.trim())
        : [],

    // Skip specific events (comma-separated)
    deniedEvents: process.env.WEBHOOK_DENIED_EVENTS
        ? process.env.WEBHOOK_DENIED_EVENTS.split(",").map(e => e.trim())
        : [],
};

// ============================================
// JID TYPE DETECTION
// ============================================

/**
 * Check if JID is a status/broadcast message
 * Status messages end with @broadcast or contain status@broadcast
 */
function isStatusJid(jid) {
    if (!jid) return false;
    return jid.endsWith("@broadcast") || jid.includes("status@broadcast");
}

/**
 * Check if JID is a group
 * Groups end with @g.us
 */
function isGroupJid(jid) {
    if (!jid) return false;
    return jid.endsWith("@g.us");
}

/**
 * Check if JID is a channel/newsletter
 * Channels end with @newsletter
 */
function isChannelJid(jid) {
    if (!jid) return false;
    return jid.endsWith("@newsletter");
}

/**
 * Check if JID is a regular private contact
 * Private contacts end with @s.whatsapp.net
 */
function isPrivateJid(jid) {
    if (!jid) return false;
    return jid.endsWith("@s.whatsapp.net");
}

/**
 * Get JID type for logging/debugging
 */
function getJidType(jid) {
    if (!jid) return "unknown";
    if (isStatusJid(jid)) return "status";
    if (isGroupJid(jid)) return "group";
    if (isChannelJid(jid)) return "channel";
    if (isPrivateJid(jid)) return "private";
    return "other";
}

// ============================================
// MESSAGE FILTERING
// ============================================

/**
 * Check if a single message should trigger a webhook
 * @param {Object} message - Baileys message object with key.remoteJid
 * @returns {boolean} - true if webhook should be sent
 */
export function shouldSendMessageWebhook(message) {
    if (!message?.key?.remoteJid) {
        return false;
    }

    const jid = message.key.remoteJid;

    // Apply filters in order of specificity
    if (FILTERS.skipStatus && isStatusJid(jid)) {
        return false;
    }

    if (FILTERS.skipGroups && isGroupJid(jid)) {
        return false;
    }

    if (FILTERS.skipChannels && isChannelJid(jid)) {
        return false;
    }

    // TODO: Implement blocked contacts filter when needed
    // if (FILTERS.skipBlocked && isBlocked(jid)) {
    //   return false;
    // }

    return true;
}

/**
 * Filter an array of messages
 * Returns only messages that should trigger webhooks
 * 
 * @param {Array} messages - Array of Baileys message objects
 * @returns {Array} - Filtered array
 */
export function filterMessages(messages) {
    if (!Array.isArray(messages)) {
        return messages;
    }

    const filtered = messages.filter(shouldSendMessageWebhook);

    // Log filtering results if any messages were filtered out
    if (filtered.length !== messages.length) {
        const removed = messages.length - filtered.length;
        const types = messages
            .filter(m => !shouldSendMessageWebhook(m))
            .map(m => getJidType(m?.key?.remoteJid));

        console.log(
            `[WebhookFilter] Filtered ${removed} message(s):`,
            types.join(", ")
        );
    }

    return filtered;
}

// ============================================
// EVENT FILTERING
// ============================================

/**
 * Check if an event should trigger a webhook
 * Supports both whitelist (allowedEvents) and blacklist (deniedEvents)
 * 
 * @param {string} eventName - Baileys event name
 * @returns {boolean} - true if webhook should be sent
 */
export function shouldSendEventWebhook(eventName) {
    if (!eventName) return false;

    // Check denied events first (blacklist)
    if (FILTERS.deniedEvents.length > 0) {
        if (FILTERS.deniedEvents.includes(eventName)) {
            return false;
        }
    }

    // Check allowed events (whitelist)
    // If allowedEvents is specified, only those events are allowed
    if (FILTERS.allowedEvents.length > 0) {
        return FILTERS.allowedEvents.includes(eventName);
    }

    // If no whitelist specified, allow all events (except blacklisted)
    return true;
}

// ============================================
// CONFIGURATION & DEBUGGING
// ============================================

/**
 * Get current filter configuration
 * Useful for debugging and admin endpoints
 * 
 * @returns {Object} - Current filter configuration with summary
 */
export function getFilterConfig() {
    return {
        filters: {
            skipStatus: FILTERS.skipStatus,
            skipGroups: FILTERS.skipGroups,
            skipChannels: FILTERS.skipChannels,
            skipBlocked: FILTERS.skipBlocked,
            allowedEvents: FILTERS.allowedEvents,
            deniedEvents: FILTERS.deniedEvents,
        },
        summary: {
            statusFiltered: FILTERS.skipStatus,
            groupsFiltered: FILTERS.skipGroups,
            channelsFiltered: FILTERS.skipChannels,
            blockedFiltered: FILTERS.skipBlocked,
            hasEventWhitelist: FILTERS.allowedEvents.length > 0,
            hasEventBlacklist: FILTERS.deniedEvents.length > 0,
            whitelistedEvents: FILTERS.allowedEvents.length,
            blacklistedEvents: FILTERS.deniedEvents.length,
        },
        jidTypes: {
            status: {
                patterns: ["@broadcast", "status@broadcast"],
                filtered: FILTERS.skipStatus
            },
            groups: {
                pattern: "@g.us",
                filtered: FILTERS.skipGroups
            },
            channels: {
                pattern: "@newsletter",
                filtered: FILTERS.skipChannels
            },
            private: {
                pattern: "@s.whatsapp.net",
                filtered: false
            }
        }
    };
}

/**
 * Get recommended Baileys v7 events for filtering
 * @returns {Object} - Event categories with descriptions
 */
export function getBaileysEventReference() {
    return {
        connection: [
            "connection.update",
            "creds.update"
        ],
        messages: [
            "messages.upsert",
            "messages.update",
            "messages.delete",
            "messages.reaction",
            "message-receipt.update"
        ],
        chats: [
            "chats.upsert",
            "chats.update",
            "chats.delete"
        ],
        contacts: [
            "contacts.upsert",
            "contacts.update"
        ],
        groups: [
            "groups.upsert",
            "groups.update",
            "group-participants.update"
        ],
        history: [
            "messaging-history.set"
        ],
        presence: [
            "presence.update"
        ],
        other: [
            "call",
            "blocklist.set",
            "blocklist.update"
        ],
        custom: [
            "qr.updated",
            "session.connected",
            "session.disconnected"
        ]
    };
}

/**
 * Validate event name against Baileys v7 standards
 * @param {string} eventName - Event name to validate
 * @returns {Object} - Validation result with suggestions
 */
export function validateEventName(eventName) {
    const allEvents = Object.values(getBaileysEventReference()).flat();

    if (allEvents.includes(eventName)) {
        return {
            valid: true,
            eventName,
            message: "Valid Baileys v7 event"
        };
    }

    // Check for common mistakes
    const suggestions = [];

    if (eventName === "messaging.history-set") {
        suggestions.push("messaging-history.set");
    }

    if (eventName.includes("_")) {
        suggestions.push(eventName.replace(/_/g, "-"));
    }

    return {
        valid: false,
        eventName,
        message: "Not a standard Baileys v7 event",
        suggestions: suggestions.length > 0 ? suggestions : allEvents.filter(e =>
            e.includes(eventName.split(".")[0]) ||
            e.includes(eventName.split("-")[0])
        )
    };
}

// ============================================
// EXPORTS
// ============================================

export default {
    // Main filtering functions
    shouldSendMessageWebhook,
    shouldSendEventWebhook,
    filterMessages,

    // JID type checking
    isStatusJid,
    isGroupJid,
    isChannelJid,
    isPrivateJid,
    getJidType,

    // Configuration
    getFilterConfig,
    getBaileysEventReference,
    validateEventName,
};