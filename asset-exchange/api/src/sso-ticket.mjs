import { createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";
import { invariant } from "../../core/src/errors.mjs";

export const SSO_DOMAIN = "GPUBNB:ASSET-EXCHANGE:SSO:v1";

export function createSsoTicket(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "SSO_TICKET_TYPE", "SSO ticket must be an object");
  const allowed = new Set(["domain","version","issuer","audience","deploymentId","subject","iatUnixMs","expUnixMs","jti"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "SSO_UNKNOWN_FIELD", `unknown SSO ticket field: ${key}`);

  invariant(input.domain === SSO_DOMAIN, "SSO_DOMAIN", "invalid SSO domain");
  invariant(input.version === 1, "SSO_VERSION", "unsupported SSO version");
  invariant(typeof input.issuer === "string" && input.issuer.length >= 3 && input.issuer.length <= 256, "SSO_ISSUER", "invalid issuer");
  invariant(typeof input.audience === "string" && input.audience.length >= 3 && input.audience.length <= 256, "SSO_AUDIENCE", "invalid audience");
  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof input.subject === "string" && input.subject.length >= 3 && input.subject.length <= 256, "SSO_SUBJECT", "invalid subject");
  invariant(Number.isSafeInteger(input.iatUnixMs) && input.iatUnixMs > 0, "SSO_IAT", "invalid issued-at");
  invariant(Number.isSafeInteger(input.expUnixMs) && input.expUnixMs > input.iatUnixMs, "SSO_EXP", "invalid expiry");
  invariant(typeof input.jti === "string" && /^[A-Za-z0-9._:-]{16,128}$/.test(input.jti), "SSO_JTI", "invalid jti");

  return Object.freeze({
    domain: SSO_DOMAIN,
    version: 1,
    issuer: input.issuer,
    audience: input.audience,
    deploymentId,
    subject: input.subject,
    iatUnixMs: input.iatUnixMs,
    expUnixMs: input.expUnixMs,
    jti: input.jti
  });
}

export function createSsoExchangeService({
  publicKeyPem,
  expectedIssuer,
  expectedAudience,
  deploymentId,
  replayStore,
  sessionManager,
  maxTicketLifetimeMs = 120_000,
  maxClockSkewMs = 30_000,
  now = () => Date.now()
}) {
  invariant(typeof publicKeyPem === "string" && publicKeyPem.length > 0, "SSO_PUBLIC_KEY", "SSO public key required");
  const publicKey = createPublicKey(publicKeyPem);
  invariant(publicKey.asymmetricKeyType === "ed25519", "SSO_KEY_TYPE", "SSO public key must be Ed25519");
  invariant(typeof expectedIssuer === "string" && expectedIssuer.length >= 3, "SSO_EXPECTED_ISSUER", "expected issuer required");
  invariant(typeof expectedAudience === "string" && expectedAudience.length >= 3, "SSO_EXPECTED_AUDIENCE", "expected audience required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);
  invariant(replayStore && typeof replayStore.consume === "function", "SSO_REPLAY_STORE", "replay store required");
  invariant(sessionManager && typeof sessionManager.issue === "function", "SSO_SESSION_MANAGER", "session manager required");
  invariant(Number.isSafeInteger(maxTicketLifetimeMs) && maxTicketLifetimeMs >= 1_000 && maxTicketLifetimeMs <= 300_000, "SSO_LIFETIME", "invalid max ticket lifetime");
  invariant(Number.isSafeInteger(maxClockSkewMs) && maxClockSkewMs >= 0 && maxClockSkewMs <= 120_000, "SSO_CLOCK_SKEW", "invalid clock skew");

  return Object.freeze({
    async exchange({ ticket, signature }) {
      const parsed = createSsoTicket(ticket);
      invariant(parsed.issuer === expectedIssuer, "SSO_ISSUER_MISMATCH", "issuer mismatch");
      invariant(parsed.audience === expectedAudience, "SSO_AUDIENCE_MISMATCH", "audience mismatch");
      invariant(parsed.deploymentId === scopedDeploymentId, "SSO_DEPLOYMENT_MISMATCH", "deployment mismatch");
      invariant(parsed.expUnixMs - parsed.iatUnixMs <= maxTicketLifetimeMs, "SSO_TICKET_TOO_LONG", "ticket lifetime too long");

      const currentTime = now();
      invariant(Number.isSafeInteger(currentTime), "SSO_CLOCK", "invalid clock");
      invariant(parsed.iatUnixMs <= currentTime + maxClockSkewMs, "SSO_FUTURE", "ticket issued too far in future");
      invariant(parsed.expUnixMs > currentTime, "SSO_EXPIRED", "ticket expired");

      invariant(typeof signature === "string" && /^[A-Za-z0-9_-]{80,128}$/.test(signature), "SSO_SIGNATURE_FORMAT", "invalid signature encoding");
      const signatureBytes = Buffer.from(signature, "base64url");
      invariant(signatureBytes.length === 64, "SSO_SIGNATURE_LENGTH", "invalid Ed25519 signature length");
      const verified = verifySignature(null, canonicalBytes(parsed), publicKey, signatureBytes);
      invariant(verified, "SSO_SIGNATURE_INVALID", "SSO signature invalid");

      const consumed = await replayStore.consume({
        jti: parsed.jti,
        issuer: parsed.issuer,
        subject: parsed.subject,
        expiresAtUnixMs: parsed.expUnixMs
      });
      invariant(consumed === true, "SSO_REPLAY", "SSO ticket already consumed");

      return sessionManager.issue({
        subject: parsed.subject,
        authnMethod: "SIGNED_SSO_TICKET"
      });
    }
  });
}
