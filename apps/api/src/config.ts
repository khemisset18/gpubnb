import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  SESSION_COOKIE_NAME: z.string().default('gpubnb_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604800).default(86400),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  TRUST_PROXY: z.enum(['true','false']).default('false'),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(131072),
  SESSION_SECRET: z.string().min(32),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  PUBLIC_APP_DOMAIN: z.string().min(3).default('localhost'),
  PLATFORM_WALLET: z.string(),
  SOLANA_CLUSTER: z.enum(['devnet', 'testnet', 'mainnet-beta']).default('devnet'),
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  SOLANA_COMMITMENT: z.enum(['confirmed', 'finalized']).default('finalized'),
  ESCROW_PROGRAM_ID: z.string().default('NOT_DEPLOYED_YET'),
  ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  DEV_PAYMENT_BYPASS: z.enum(['true', 'false']).default('false'),
  // Distinct from DEV_PAYMENT_BYPASS: allowed in production, but only ever has an effect
  // while ESCROW_PROGRAM_ID is still the NOT_DEPLOYED_YET placeholder (checked at every use
  // site, not just here), so it can never bypass a real payment once escrow is deployed.
  // Exists to unblock the private-beta two-machine test protocol (BETA_PRIVATE_TEST_PLAN.md)
  // without weakening the NODE_ENV==='production' guard on DEV_PAYMENT_BYPASS below.
  BETA_TEST_DEV_BYPASS: z.enum(['true', 'false']).default('false'),
  DEV_DIAGNOSTIC_IMAGE: z.string().regex(/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/).optional(),
  HEARTBEAT_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  HEARTBEAT_OFFLINE_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  JOB_STALE_AFTER_SECONDS: z.coerce.number().int().min(120).max(3600).default(900),
  COMMISSION_BPS: z.coerce.number().int().min(0).max(1000).default(500),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(20).optional(),
  FILE_STORAGE_DIR: z.string().default('./data/artifacts'),
  MAX_ARTIFACT_BYTES: z.coerce.number().int().min(1024).max(500_000_000).default(104_857_600),
});

export const config = schema.parse(process.env);
new PublicKey(config.PLATFORM_WALLET);

const redisUrl = new URL(config.REDIS_URL);
const isTlsRedis = redisUrl.protocol === 'rediss:';
const isPrivateRenderRedis =
  process.env.RENDER === 'true' &&
  redisUrl.protocol === 'redis:' &&
  redisUrl.port === '6379' &&
  /^red-[a-z0-9-]+$/.test(redisUrl.hostname);

if (config.NODE_ENV === 'production' && !isTlsRedis && !isPrivateRenderRedis) {
  throw new Error('Production Redis must use TLS or a private Render Key Value URL');
}
if (config.NODE_ENV === 'production' && config.DEV_PAYMENT_BYPASS === 'true') {
  throw new Error('DEV_PAYMENT_BYPASS is forbidden in production');
}
if (config.SOLANA_CLUSTER === 'mainnet-beta' && config.ALLOW_MAINNET !== 'true') {
  throw new Error('Mainnet is disabled until independent audit approval');
}
if (config.COMMISSION_BPS !== 500) throw new Error('Commission must remain 500 bps for this release');

if (config.NODE_ENV === 'production' && config.PUBLIC_APP_DOMAIN === 'localhost') throw new Error('PUBLIC_APP_DOMAIN must be configured in production');
if (config.SOLANA_CLUSTER === 'mainnet-beta' && config.SOLANA_COMMITMENT !== 'finalized') throw new Error('Mainnet deposits must use finalized commitment');
if (config.SOLANA_CLUSTER === 'mainnet-beta' && /api\.mainnet-beta\.solana\.com/.test(config.SOLANA_RPC_URL)) throw new Error('Use a private authenticated RPC endpoint for mainnet');
