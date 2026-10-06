import { invariant } from "../../core/src/errors.mjs";

function parsePort(value) {
  if (value === undefined) return 8787;
  invariant(/^[0-9]+$/.test(value), "API_PORT_FORMAT", "ASSET_EXCHANGE_API_PORT must be an integer");
  const port = Number(value);
  invariant(Number.isSafeInteger(port) && port >= 1 && port <= 65535, "API_PORT_RANGE", "invalid API port");
  return port;
}

function parseOrigins(value) {
  if (value === undefined || value === "") return [];
  const origins = value.split(",").map((v) => v.trim());
  invariant(origins.every((v) => v.length > 0), "API_ORIGIN_FORMAT", "empty origin is not allowed");
  invariant(!origins.includes("*"), "API_ORIGIN_WILDCARD", "wildcard CORS origin is forbidden");
  return Object.freeze(origins);
}

export function loadApiConfig(env = process.env, { requireDataStores = false } = {}) {
  invariant(env && typeof env === "object", "API_ENV", "environment object required");

  if (!env.ASSET_EXCHANGE_DATABASE_URL && env.DATABASE_URL) {
    throw new Error("Core DATABASE_URL fallback is forbidden; configure ASSET_EXCHANGE_DATABASE_URL explicitly");
  }
  if (!env.ASSET_EXCHANGE_REDIS_URL && env.REDIS_URL) {
    throw new Error("Core REDIS_URL fallback is forbidden; configure ASSET_EXCHANGE_REDIS_URL explicitly");
  }

  if (requireDataStores) {
    invariant(typeof env.ASSET_EXCHANGE_DATABASE_URL === "string" && env.ASSET_EXCHANGE_DATABASE_URL.length > 0, "AE_DB_REQUIRED", "Asset Exchange database URL required");
    invariant(typeof env.ASSET_EXCHANGE_REDIS_URL === "string" && env.ASSET_EXCHANGE_REDIS_URL.length > 0, "AE_REDIS_REQUIRED", "Asset Exchange Redis URL required");
  }

  const host = env.ASSET_EXCHANGE_API_HOST ?? "127.0.0.1";
  invariant(host !== "0.0.0.0" || env.ASSET_EXCHANGE_ALLOW_PUBLIC_BIND === "true", "API_PUBLIC_BIND", "public bind requires explicit ASSET_EXCHANGE_ALLOW_PUBLIC_BIND=true");

  return Object.freeze({
    host,
    port: parsePort(env.ASSET_EXCHANGE_API_PORT),
    databaseUrl: env.ASSET_EXCHANGE_DATABASE_URL ?? null,
    redisUrl: env.ASSET_EXCHANGE_REDIS_URL ?? null,
    allowedOrigins: parseOrigins(env.ASSET_EXCHANGE_ALLOWED_ORIGINS)
  });
}
