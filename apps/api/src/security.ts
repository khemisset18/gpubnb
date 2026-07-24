import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export function constantTimeToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function assertTrustedOrigin(req: FastifyRequest, reply: FastifyReply, domain: string): boolean {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients rely on SameSite cookies and signatures
  try {
    const host = new URL(origin).host.toLowerCase();
    if (host === domain.toLowerCase()) return true;
  } catch {}
  reply.code(403).send({error:'untrusted_origin'}); return false;
}

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const validAgentTimestamp = (value: string | undefined): number | null => {
  if (!value) return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && Math.abs(Date.now() - epoch) <= 30_000 ? epoch : null;
};

const verifyDetached = (canonical: string, signature: string, publicKey: string): boolean => {
  if (signature.length > 200) return false;
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      bs58.decode(signature),
      bs58.decode(publicKey),
    );
  } catch {
    return false;
  }
};

export async function verifyAgentRequest(
  redis: Redis, machineId: string, publicKey: string, method: string, path: string,
  timestampHeader: string | string[] | undefined, signatureHeader: string | string[] | undefined,
): Promise<boolean> {
  const timestamp = firstHeader(timestampHeader);
  const signature = firstHeader(signatureHeader);
  const epoch = validAgentTimestamp(timestamp);
  if (epoch === null || !signature) return false;
  const canonical = `${method.toUpperCase()}|${path}|${machineId}|${epoch}`;
  if (!verifyDetached(canonical, signature, publicKey)) return false;
  return (await redis.set(`agent-request:${machineId}:${epoch}:${signature}`, '1', 'EX', 60, 'NX')) === 'OK';
}

export type AgentV2Headers = {
  timestamp: string | string[] | undefined;
  nonce: string | string[] | undefined;
  bodySha256: string | string[] | undefined;
  signature: string | string[] | undefined;
  version: string | string[] | undefined;
};

export async function verifyAgentRequestV2(
  redis: Redis,
  machineId: string,
  publicKey: string,
  method: string,
  path: string,
  bodyBytes: Uint8Array,
  headers: AgentV2Headers,
): Promise<boolean> {
  if (firstHeader(headers.version) !== '2') return false;
  const timestamp = firstHeader(headers.timestamp);
  const nonce = firstHeader(headers.nonce);
  const claimedBodyHash = firstHeader(headers.bodySha256);
  const signature = firstHeader(headers.signature);
  const epoch = validAgentTimestamp(timestamp);
  if (epoch === null || !nonce || !claimedBodyHash || !signature) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  if (!/^[a-f0-9]{64}$/.test(claimedBodyHash)) return false;

  const actualBodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  if (!constantTimeToken(claimedBodyHash, actualBodyHash)) return false;

  const canonical = `${method.toUpperCase()}|${path}|${machineId}|${epoch}|${nonce}|${actualBodyHash}`;
  if (!verifyDetached(canonical, signature, publicKey)) return false;

  const replayDigest = crypto
    .createHash('sha256')
    .update(`${machineId}\u0000${epoch}\u0000${nonce}\u0000${signature}`)
    .digest('hex');
  return (await redis.set(`agent-request-v2:${replayDigest}`, '1', 'EX', 60, 'NX')) === 'OK';
}

export async function recordSecurityFailure(redis: Redis, scope: string, limit = 8): Promise<boolean> {
  const key = `security-fail:${scope}`;
  const count = await redis.incr(key); if (count === 1) await redis.expire(key, 900);
  return count >= limit;
}
