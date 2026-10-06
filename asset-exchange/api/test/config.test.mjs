import test from "node:test";
import assert from "node:assert/strict";
import { loadApiConfig } from "../src/config.mjs";

test("API refuses silent Core database fallback", () => {
  assert.throws(() => loadApiConfig({ DATABASE_URL: "postgres://core" }));
  assert.throws(() => loadApiConfig({ REDIS_URL: "redis://core" }));
});

test("API requires explicit Asset Exchange datastore names when enabled", () => {
  assert.throws(() => loadApiConfig({}, { requireDataStores: true }));
  const cfg = loadApiConfig({
    ASSET_EXCHANGE_DATABASE_URL: "postgres://asset-exchange",
    ASSET_EXCHANGE_REDIS_URL: "redis://asset-exchange"
  }, { requireDataStores: true });
  assert.equal(cfg.databaseUrl, "postgres://asset-exchange");
  assert.equal(cfg.redisUrl, "redis://asset-exchange");
});

test("wildcard CORS and accidental public bind fail closed", () => {
  assert.throws(() => loadApiConfig({ ASSET_EXCHANGE_ALLOWED_ORIGINS: "*" }));
  assert.throws(() => loadApiConfig({ ASSET_EXCHANGE_API_HOST: "0.0.0.0" }));

  const cfg = loadApiConfig({
    ASSET_EXCHANGE_API_HOST: "0.0.0.0",
    ASSET_EXCHANGE_ALLOW_PUBLIC_BIND: "true",
    ASSET_EXCHANGE_ALLOWED_ORIGINS: "https://exchange.example"
  });
  assert.equal(cfg.host, "0.0.0.0");
  assert.deepEqual(cfg.allowedOrigins, ["https://exchange.example"]);
});
