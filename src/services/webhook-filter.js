/**
 * Webhook filtering system
 * Controls which messages/events should trigger webhooks based on configuration
 */

// Parse filter configuration from environment variables
const FILTERS = {
    // Skip broadcast/status messages
    skipStatus: process.env.WEBHOOK_SKIP_STATUS !== "false",

    // Skip group messages
    skipGroups: process.env.WEBHOOK_SKIP_GROUPS === "true",

    // Skip channel/newsletter messages
    skipChannels: process.env.WEBHOOK_SKIP_CHANNELS !== "false",

    // Skip messages from blocked contacts
    skipBlocked: process.env.WEBHOOK_SKIP_BLOCKED === "true",

    // Only send specific events (comma-separated list, empty = all events)
    allowedEvents: process.env.WEBHOOK_ALLOWED_EVENTS
        ? process.env.WEBHOOK_ALLOWED_EVENTS.split(",").map(e => e.trim())
        : [],

    // Skip specific events (comma-separated list)
    deniedEvents: process.env.WEBHOOK_DENIED_EVENTS
        ? process.env.WEBHOOK_DENIED_EVENTS.split(",").map(e => e.trim())
        : [],
};

/**
 * Check if a JID represents a status/broadcast
 */
function isStatusJid(jid) {
    return jid?.endsWith("@broadcast") || jid?.includes("status@broadcast");
}

/**
 * Check if a JID represents a group
 */
function isGroupJid(jid) {
    return jid?.endsWith("@g.us");
}

/**
 * Check if a JID represents a channel/newsletter
 */
function isChannelJid(jid) {
    return jid?.endsWith("@newsletter");
}

/**
 * Check if a JID represents a regular private contact
 */
function isPrivateJid(jid) {
    return jid?.endsWith("@s.whatsapp.net");
}

/**
 * Filter messages based on configuration
 * Returns true if the message should trigger a webhook
 */
export function shouldSendMessageWebhook(message) {
    if (!message?.key?.remoteJid) return false;

    const jid = message.key.remoteJid;

    // Apply filters
    if (FILTERS.skipStatus && isStatusJid(jid)) {
        return false;
    }

    if (FILTERS.skipGroups && isGroupJid(jid)) {
        return false;
    }

    if (FILTERS.skipChannels && isChannelJid(jid)) {
        return false;
    }

    return true;
}

/**
 * Filter events based on configuration
 * Returns true if the event should trigger a webhook
 */
export function shouldSendEventWebhook(eventName) {
    // Check denied events first
    if (FILTERS.deniedEvents.length > 0) {
        if (FILTERS.deniedEvents.includes(eventName)) {
            return false;
        }
    }

    // Check allowed events (if specified, only these are allowed)
    if (FILTERS.allowedEvents.length > 0) {
        return FILTERS.allowedEvents.includes(eventName);
    }

    return true;
}

/**
 * Get current filter configuration (for debugging/admin)
 */
export function getFilterConfig() {
    return {
        ...FILTERS,
        summary: {
            statusFiltered: FILTERS.skipStatus,
            groupsFiltered: FILTERS.skipGroups,
            channelsFiltered: FILTERS.skipChannels,
            blockedFiltered: FILTERS.skipBlocked,
            eventWhitelist: FILTERS.allowedEvents.length > 0,
            eventBlacklist: FILTERS.deniedEvents.length > 0,
        }
    };
}

/**
 * Apply filters to a messages.upsert payload
 * Returns filtered messages array
 */
export function filterMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.filter(shouldSendMessageWebhook);
}