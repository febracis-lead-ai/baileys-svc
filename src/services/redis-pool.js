import Redis from "ioredis";
import { getRedisConfig } from "../config.js";

class RedisPool {
  constructor() {
    this.instance = null;
    this.isConnected = false;
  }

  async getClient() {
    if (this.instance && this.isConnected) {
      return this.instance;
    }

    const redisConfig = getRedisConfig();

    const options = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 10000,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      enableOfflineQueue: true,
      lazyConnect: false,
      keepAlive: 10000,
      connectionName: "baileys-svc",
    };

    if (typeof redisConfig === "string") {
      this.instance = new Redis(redisConfig, options);
    } else {
      this.instance = new Redis({
        ...redisConfig,
        ...options,
      });
    }

    this.instance.on("connect", () => {
      const connInfo = typeof redisConfig === "string"
        ? redisConfig
        : `${redisConfig.host}:${redisConfig.port}/${redisConfig.db}`;
      console.log(`[RedisPool] Connected to ${connInfo}`);
      this.isConnected = true;
    });

    this.instance.on("error", (err) => {
      console.error("[RedisPool] Error:", err?.message || err);
    });

    this.instance.on("close", () => {
      console.warn("[RedisPool] Connection closed");
      this.isConnected = false;
    });

    this.instance.on("reconnecting", (delay) => {
      console.log(`[RedisPool] Reconnecting in ${delay}ms...`);
    });

    await this.instance.ping();

    return this.instance;
  }

  async disconnect() {
    if (this.instance) {
      await this.instance.quit();
      this.instance = null;
      this.isConnected = false;
    }
  }

  async batchOperation(operations) {
    const client = await this.getClient();
    const pipeline = client.pipeline();

    for (const op of operations) {
      pipeline[op.method](...op.args);
    }

    return pipeline.exec();
  }

  async *scan(pattern = "*", count = 100) {
    const client = await this.getClient();
    let cursor = "0";

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        count
      );
      cursor = nextCursor;
      if (keys.length) yield keys;
    } while (cursor !== "0");
  }

  async deleteByPattern(pattern) {
    let deleted = 0;

    for await (const keys of this.scan(pattern, 1000)) {
      const client = await this.getClient();
      if (keys.length) {
        await client.del(...keys);
        deleted += keys.length;
      }
    }

    return deleted;
  }
}

export const redisPool = new RedisPool();

process.on("SIGINT", async () => {
  console.log("[RedisPool] Gracefully shutting down...");
  await redisPool.disconnect();
  process.exit(0);
});