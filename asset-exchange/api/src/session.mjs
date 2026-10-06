import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { invariant } from "../../core/src/errors.mjs";
import { createActor } from "./authz.mjs";

const COOKIE_NAME = "__Host-gpubnb-ae-session";

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest();
}

function token() {
  return randomBytes(32).toString("base64url");
}

function equalHash(a, b) {
  const ah = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bh = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return ah.length === bh.length && timingSafeEqual(ah, bh);
}

export function parseCookieHeader(header) {
  if (header === undefined) return new Map();
  invariant(typeof header === "string" && header.length <= 8192, "COOKIE_HEADER", "invalid cookie header");
  const result = new Map();
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const index = part.indexOf("=");
    invariant(index > 0, "COOKIE_FORMAT", "malformed cookie");
    const name = part.slice(0, index);
    const value = part.slice(index + 1);
    invariant(!result.has(name), "COOKIE_DUPLICATE", "duplicate cookie name");
    result.set(name, value);
  }
  return result;
}

export function createMemorySessionStore() {
  const rows = new Map();
  return Object.freeze({
    async put(sessionHashHex, record) { rows.set(sessionHashHex, structuredClone(record)); },
    async get(sessionHashHex) {
      const value = rows.get(sessionHashHex);
      return value ? structuredClone(value) : null;
    },
    async delete(sessionHashHex) { rows.delete(sessionHashHex); },
    async revokeSubject(subject) {
      for (const [key, value] of rows) if (value.subject === subject) rows.delete(key);
    }
  });
}

export function createSessionManager({
  store,
  ttlMs = 30 * 60 * 1000,
  now = () => Date.now()
}) {
  invariant(store && typeof store.get === "function" && typeof store.put === "function" && typeof store.delete === "function", "SESSION_STORE", "session store interface required");
  invariant(Number.isSafeInteger(ttlMs) && ttlMs >= 60_000 && ttlMs <= 24 * 60 * 60 * 1000, "SESSION_TTL", "invalid session ttl");
  invariant(typeof now === "function", "SESSION_CLOCK", "session clock required");

  return Object.freeze({
    async issue({ subject, authnMethod = "EXCHANGE_SESSION" }) {
      const sessionId = token();
      const csrfToken = token();
      const sessionHash = sha256Buffer(sessionId).toString("hex");
      const csrfHash = sha256Buffer(csrfToken).toString("hex");
      const createdAtUnixMs = now();
      const expiresAtUnixMs = createdAtUnixMs + ttlMs;
      const actor = createActor({ subject, sessionId: sessionHash, authnMethod });

      await store.put(sessionHash, {
        subject: actor.subject,
        authnMethod: actor.authnMethod,
        csrfHash,
        createdAtUnixMs,
        expiresAtUnixMs
      });

      return Object.freeze({
        cookie: `${COOKIE_NAME}=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict`,
        csrfToken,
        expiresAtUnixMs
      });
    },

    async authenticateRequest(req) {
      const cookies = parseCookieHeader(req.headers.cookie);
      const rawSessionId = cookies.get(COOKIE_NAME);
      invariant(typeof rawSessionId === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(rawSessionId), "AUTH_REQUIRED", "valid Exchange session required");

      const sessionHash = sha256Buffer(rawSessionId).toString("hex");
      const record = await store.get(sessionHash);
      invariant(record !== null, "AUTH_REQUIRED", "session not found");

      const currentTime = now();
      invariant(Number.isSafeInteger(currentTime), "SESSION_CLOCK_VALUE", "invalid session clock");
      if (record.expiresAtUnixMs <= currentTime) {
        await store.delete(sessionHash);
        invariant(false, "SESSION_EXPIRED", "session expired");
      }

      return createActor({
        subject: record.subject,
        sessionId: sessionHash,
        authnMethod: record.authnMethod
      });
    },

    async assertCsrf(req, actor) {
      const raw = req.headers["x-csrf-token"];
      invariant(typeof raw === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(raw), "CSRF_REQUIRED", "csrf token required");
      const record = await store.get(actor.sessionId);
      invariant(record !== null, "AUTH_REQUIRED", "session not found");
      const presented = sha256Buffer(raw);
      const expected = Buffer.from(record.csrfHash, "hex");
      invariant(equalHash(presented, expected), "CSRF_INVALID", "csrf token invalid");
      return true;
    },

    async revokeRequest(req) {
      const cookies = parseCookieHeader(req.headers.cookie);
      const rawSessionId = cookies.get(COOKIE_NAME);
      if (typeof rawSessionId !== "string") return;
      await store.delete(sha256Buffer(rawSessionId).toString("hex"));
    }
  });
}

export { COOKIE_NAME };
