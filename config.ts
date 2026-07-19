import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  SESSION_COOKIE_NAME: z.string().default('gpubnb_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604800).default(86400),
  SESSION_SECRET: z.string().min(32),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  PLATFORM_WALLET: z.string(),
  SOLANA_CLUSTER: z.enum(['devnet', 'testnet', 'mainnet-beta']).default('devnet'),
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  ESCROW_PROGRAM_ID: z.string().default('NOT_DEPLOYED_YET'),
  ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  HEARTBEAT_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(120).default(25),
  HEARTBEAT_OFFLINE_SECONDS: z.coerce.number().int().min(15).max(300).default(40),
  COMMISSION_BPS: z.coerce.number().int().min(0).max(1000).default(500),
});

export const config = schema.parse(process.env);
new PublicKey(config.PLATFORM_WALLET);
if (config.NODE_ENV === 'production' && !config.REDIS_URL.startsWith('rediss://')) throw new Error('Production Redis must use TLS (rediss://)');
if (config.SOLANA_CLUSTER === 'mainnet-beta' && config.ALLOW_MAINNET !== 'true') {
  throw new Error('Mainnet is disabled until independent audit approval');
}
if (config.COMMISSION_BPS !== 500) throw new Error('Commission must remain 500 bps for this release');
