import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

const optionalEnvironmentUrl = z.preprocess(value => value === '' ? undefined : value, z.string().url().optional());
const optionalEnvironmentSecret = z.preprocess(value => value === '' ? undefined : value, z.string().min(20).optional());

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
  PUBLIC_APP_DOMAIN: z.string().regex(/^(localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::\d{1,5})?$/i).default('localhost'),
  PLATFORM_WALLET: z.string(),
  SOLANA_CLUSTER: z.enum(['devnet', 'testnet', 'mainnet-beta']).default('devnet'),
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  SOLANA_COMMITMENT: z.enum(['confirmed', 'finalized']).default('finalized'),
  ESCROW_PROGRAM_ID: z.string().default('NOT_DEPLOYED_YET'),
  ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  HEARTBEAT_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  HEARTBEAT_OFFLINE_SECONDS: z.coerce.number().int().min(15).max(300).default(40),
  COMMISSION_BPS: z.coerce.number().int().min(0).max(1000).default(500),
  SUPABASE_URL: optionalEnvironmentUrl,
  SUPABASE_ANON_KEY: optionalEnvironmentSecret,
});

export const config = schema.parse(process.env);
new PublicKey(config.PLATFORM_WALLET);
if ((config.SUPABASE_URL === undefined) !== (config.SUPABASE_ANON_KEY === undefined)) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured together');
if (config.NODE_ENV === 'production' && !config.REDIS_URL.startsWith('rediss://')) throw new Error('Production Redis must use TLS (rediss://)');
if (config.SOLANA_CLUSTER === 'mainnet-beta' && config.ALLOW_MAINNET !== 'true') {
  throw new Error('Mainnet is disabled until independent audit approval');
}
if (config.COMMISSION_BPS !== 500) throw new Error('Commission must remain 500 bps for this release');

if (config.NODE_ENV === 'production' && config.PUBLIC_APP_DOMAIN === 'localhost') throw new Error('PUBLIC_APP_DOMAIN must be configured in production');
if (config.SOLANA_CLUSTER === 'mainnet-beta' && config.SOLANA_COMMITMENT !== 'finalized') throw new Error('Mainnet deposits must use finalized commitment');
if (config.SOLANA_CLUSTER === 'mainnet-beta' && /api\.mainnet-beta\.solana\.com/.test(config.SOLANA_RPC_URL)) throw new Error('Use a private authenticated RPC endpoint for mainnet');
