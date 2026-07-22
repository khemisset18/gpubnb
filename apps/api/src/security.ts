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

export const validCsrfToken = constantTimeToken;

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

export async function verifyAgentRequest(
  redis: Redis, machineId: string, publicKey: string, method: string, path: string,
  timestampHeader: string | string[] | undefined, signatureHeader: string | string[] | undefined,
): Promise<boolean> {
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !signature || signature.length > 200) return false;
  const epoch = Number(timestamp);
  if (!Number.isSafeInteger(epoch) || Math.abs(Date.now() - epoch) > 30_000) return false;
  const canonical = `${method.toUpperCase()}|${path}|${machineId}|${epoch}`;
  let valid = false;
  try { valid = nacl.sign.detached.verify(new TextEncoder().encode(canonical), bs58.decode(signature), bs58.decode(publicKey)); } catch {}
  if (!valid) return false;
  return (await redis.set(`agent-request:${machineId}:${epoch}:${signature}`, '1', 'EX', 60, 'NX')) === 'OK';
}

export async function recordSecurityFailure(redis: Redis, scope: string, limit = 8): Promise<boolean> {
  const key = `security-fail:${scope}`;
  const count = await redis.incr(key); if (count === 1) await redis.expire(key, 900);
  return count >= limit;
}
