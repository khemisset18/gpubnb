import { invariant } from "../../core/src/errors.mjs";

export function createActor(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "ACTOR_TYPE", "actor context required");
  const allowed = new Set(["subject", "sessionId", "authnMethod"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "ACTOR_UNKNOWN_FIELD", `unknown actor field: ${key}`);

  invariant(typeof input.subject === "string" && input.subject.length >= 3 && input.subject.length <= 256, "ACTOR_SUBJECT", "invalid actor subject");
  invariant(typeof input.sessionId === "string" && input.sessionId.length >= 8 && input.sessionId.length <= 256, "ACTOR_SESSION", "invalid session id");
  invariant(["EXCHANGE_SESSION", "SIGNED_SSO_TICKET"].includes(input.authnMethod), "ACTOR_AUTHN", "unsupported authentication method");

  return Object.freeze({ ...input });
}

export function assertSameSubject(actor, expectedSubject) {
  const parsed = createActor(actor);
  invariant(parsed.subject === expectedSubject, "OBJECT_AUTHZ", "actor is not authorized for this object");
  return parsed;
}

export function validateIdempotencyKey(value) {
  invariant(typeof value === "string", "IDEMPOTENCY_TYPE", "idempotency key must be a string");
  invariant(/^[A-Za-z0-9._:-]{16,128}$/.test(value), "IDEMPOTENCY_FORMAT", "invalid idempotency key");
  return value;
}
