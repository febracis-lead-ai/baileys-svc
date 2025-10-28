import Redis from "ioredis";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { getRedisConfig } from "../config.js";

/**
 * Redis-backed Baileys auth state (creds + signal keys).
 * - Uses BufferJSON.{replacer,reviver} to preserve binary fields
 * - Pipelines for fewer round-trips
 * - SCAN for clears (avoids KEYS)
 * - Tolerates slow start with retryStrategy
 */
export async function useRedisAuthState(sessionId) {
  const redisConfig = getRedisConfig();

  const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 10_000,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
  };

  const redis = typeof redisConfig === "string"
    ? new Redis(redisConfig, options)
    : new Redis({ ...redisConfig, ...options });

  redis.on("connect", () => {
    const connInfo = typeof redisConfig === "string"
      ? redisConfig
      : `${redisConfig.host}:${redisConfig.port}/${redisConfig.db}`;
    console.log(`[Redis] Connected: ${connInfo} (session=${sessionId})`);
  });

  redis.on("error", (err) =>
    console.error(`[Redis Error] session=${sessionId}`, err?.message || err)
  );

  redis.on("close", () =>
    console.warn(`[Redis] Closed (session=${sessionId})`)
  );

  const prefix = `wa:${sessionId}:`;

  const parse = (s) => (s ? JSON.parse(s, BufferJSON.reviver) : null);
  const stringify = (o) => JSON.stringify(o, BufferJSON.replacer);

  async function readData(key) {
    const raw = await redis.get(prefix + key);
    return parse(raw);
  }
  async function writeData(key, data) {
    await redis.set(prefix + key, stringify(data));
  }

  // creds: load or initialize
  const creds = (await readData("creds")) || initAuthCreds();

  const state = {
    creds,
    keys: {
      // returns { id: value } for each requested id
      get: async (type, ids) => {
        if (!ids?.length) return {};
        const pipe = redis.pipeline();
        for (const id of ids) pipe.get(`${prefix}${type}-${id}`);
        const out = {};
        const results = await pipe.exec();
        results.forEach(([, val], i) => {
          if (val) out[ids[i]] = parse(val);
        });
        return out;
      },

      // sets multiple keys at once
      set: async (data) => {
        const pipe = redis.pipeline();
        for (const category in data) {
          for (const id in data[category]) {
            pipe.set(
              `${prefix}${category}-${id}`,
              stringify(data[category][id])
            );
          }
        }
        await pipe.exec();
      },

      // clears a whole category using SCAN (no KEYS)
      clear: async (type) => {
        let cursor = "0";
        do {
          const [next, keys] = await redis.scan(
            cursor,
            "MATCH",
            `${prefix}${type}-*`,
            "COUNT",
            "1000"
          );
          cursor = next;
          if (keys.length) await redis.del(keys);
        } while (cursor !== "0");
      },
    },
  };

  async function saveCreds() {
    await writeData("creds", state.creds);
  }

  return { state, saveCreds, redis };
}