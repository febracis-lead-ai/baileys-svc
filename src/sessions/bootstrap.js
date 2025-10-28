import Redis from "ioredis";
import { ensureSession } from "./manager.js";
import { getRedisConfig } from "../config.js";

function sessionIdFromKey(k) {
  // k: "wa:<sessionId>:<qualquerCoisa>"
  const m = /^wa:(.+?):.+$/.exec(k);
  return m?.[1] || null;
}

/**
 * Reinicia TODAS as sessões encontradas no Redis (qualquer chave "wa:<sessionId>:*").
 */
export async function restoreAllSessions() {
  const redisConfig = getRedisConfig();

  if (!redisConfig) {
    console.warn("[bootstrap] Redis não configurado; pulando restore.");
    return;
  }

  const options = {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  };

  // Create Redis instance based on config type
  const redis = typeof redisConfig === "string"
    ? new Redis(redisConfig, options)
    : new Redis({ ...redisConfig, ...options });

  await new Promise((res) => redis.once("ready", res));

  let cursor = "0";
  const found = new Set();

  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      "wa:*",
      "COUNT",
      "1000"
    );
    cursor = next;
    for (const k of keys) {
      const id = sessionIdFromKey(k);
      if (id) found.add(id);
    }
  } while (cursor !== "0");

  if (!found.size) {
    console.log("[bootstrap] Nenhuma sessão encontrada no Redis.");
    redis.disconnect();
    return;
  }

  console.log(
    `[bootstrap] Encontradas ${found.size} sessão(ões). Reiniciando todas...`
  );

  for (const id of found) {
    try {
      await ensureSession(id);
      console.log(`[bootstrap] reiniciou sessão '${id}'`);
    } catch (e) {
      console.error(`[bootstrap] falha ao reiniciar '${id}':`, e.message);
    }
  }

  redis.disconnect();
}