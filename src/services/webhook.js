import { redisPool } from "./redis-pool.js";
import {
  WEBHOOK_URL,
  WEBHOOK_AUTH_TYPE,
  WEBHOOK_AUTH_USER,
  WEBHOOK_AUTH_PASSWORD,
  WEBHOOK_AUTH_TOKEN,
} from "../config.js";

class WebhookQueue {
  constructor() {
    this.queueKey = "webhook:queue";
    this.processingKey = "webhook:processing";
    this.failedKey = "webhook:failed";
    this.isProcessing = false;
    this.maxRetries = 3;
    this.batchSize = 10;
    this.retryDelay = 5000;
  }

  async enqueue(sessionId, event, payload) {
    if (!WEBHOOK_URL) return { ok: false, reason: "no-webhook-url" };

    const webhook = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId,
      event,
      payload,
      ts: Date.now(),
      attempts: 0,
      lastAttempt: null,
      errors: [],
    };

    const redis = await redisPool.getClient();
    await redis.lpush(this.queueKey, JSON.stringify(webhook));

    if (!this.isProcessing) {
      this.startProcessing();
    }

    return { ok: true, id: webhook.id };
  }

  async startProcessing() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    console.log("[WebhookQueue] Starting webhook processor...");

    while (this.isProcessing) {
      try {
        await this.processBatch();
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        console.error("[WebhookQueue] Processing error:", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async processBatch() {
    const redis = await redisPool.getClient();
    const webhooks = [];

    for (let i = 0; i < this.batchSize; i++) {
      const item = await redis.rpoplpush(this.queueKey, this.processingKey);
      if (!item) break;
      webhooks.push(JSON.parse(item));
    }

    if (webhooks.length === 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return;
    }

    const results = await Promise.allSettled(
      webhooks.map((webhook) => this.sendWebhook(webhook))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const webhook = webhooks[i];

      if (result.status === "fulfilled" && result.value.ok) {
        await redis.lrem(this.processingKey, 1, JSON.stringify(webhook));
        console.log(`[WebhookQueue] Sent webhook ${webhook.id} successfully`);
      } else {
        await this.handleFailedWebhook(webhook, result.reason || result.value);
      }
    }
  }

  async handleFailedWebhook(webhook, error) {
    const redis = await redisPool.getClient();

    webhook.attempts++;
    webhook.lastAttempt = Date.now();
    webhook.errors.push({
      attempt: webhook.attempts,
      error: String(error),
      ts: Date.now(),
    });

    await redis.lrem(this.processingKey, 1, JSON.stringify(webhook));

    if (webhook.attempts < this.maxRetries) {
      const delay = this.retryDelay * Math.pow(2, webhook.attempts - 1);
      console.log(
        `[WebhookQueue] Webhook ${webhook.id} failed (attempt ${webhook.attempts}/${this.maxRetries}), retrying in ${delay}ms`
      );

      setTimeout(async () => {
        await redis.lpush(this.queueKey, JSON.stringify(webhook));
      }, delay);
    } else {
      await redis.lpush(this.failedKey, JSON.stringify(webhook));
      console.error(
        `[WebhookQueue] Webhook ${webhook.id} failed after ${this.maxRetries} attempts`
      );
    }
  }

  async sendWebhook(webhook) {
    const { sessionId, event, payload, ts } = webhook;
    const body = JSON.stringify({ sessionId, event, payload, ts });

    const headers = { "Content-Type": "application/json" };

    if (
      WEBHOOK_AUTH_TYPE === "basic" &&
      WEBHOOK_AUTH_USER &&
      WEBHOOK_AUTH_PASSWORD
    ) {
      const credentials = Buffer.from(
        `${WEBHOOK_AUTH_USER}:${WEBHOOK_AUTH_PASSWORD}`
      ).toString("base64");
      headers["Authorization"] = `Basic ${credentials}`;
    } else if (WEBHOOK_AUTH_TYPE === "token" && WEBHOOK_AUTH_TOKEN) {
      headers["Authorization"] = `Token ${WEBHOOK_AUTH_TOKEN}`;
    } else if (WEBHOOK_AUTH_TYPE === "bearer" && WEBHOOK_AUTH_TOKEN) {
      headers["Authorization"] = `Bearer ${WEBHOOK_AUTH_TOKEN}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        body,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return { ok: true, status: response.status };
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(err?.message || String(err));
    }
  }

  async getStats() {
    const redis = await redisPool.getClient();
    const [pending, processing, failed] = await Promise.all([
      redis.llen(this.queueKey),
      redis.llen(this.processingKey),
      redis.llen(this.failedKey),
    ]);

    return {
      pending,
      processing,
      failed,
      isProcessing: this.isProcessing,
    };
  }

  async retryFailed(count = 10) {
    const redis = await redisPool.getClient();
    let retried = 0;

    for (let i = 0; i < count; i++) {
      const item = await redis.rpoplpush(this.failedKey, this.queueKey);
      if (!item) break;

      const webhook = JSON.parse(item);
      webhook.attempts = 0;
      webhook.errors = [];

      await redis.lrem(this.queueKey, 1, item);
      await redis.lpush(this.queueKey, JSON.stringify(webhook));
      retried++;
    }

    return retried;
  }

  stopProcessing() {
    this.isProcessing = false;
    console.log("[WebhookQueue] Stopping webhook processor...");
  }
}

export const webhookQueue = new WebhookQueue();

export async function sendWebhook(sessionId, event, payload) {
  return webhookQueue.enqueue(sessionId, event, payload);
}

webhookQueue.startProcessing();
