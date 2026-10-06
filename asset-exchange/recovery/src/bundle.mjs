import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { assertNoForbiddenSecrets, createRecoveryMetadata } from "./metadata.mjs";

export const RECOVERY_DOMAIN = "GPUBNB:ASSET-EXCHANGE:RECOVERY:v1";
export const RECOVERY_CIPHER = "AES-256-GCM";

const ARTIFACT_TYPES = new Set([
  "SIGNED_REFUND_TX",
  "REFUND_PSBT",
  "LOCK_TX",
  "LOCK_TXID",
  "LOCK_SCRIPT",
  "REDEEM_TX_TEMPLATE",
  "CHAIN_RECOVERY_RECIPE"
]);

const ENCODINGS = new Set(["HEX","BASE64","UTF8","JSON"]);

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromB64url(value, field, min = 1, max = 16 * 1024 * 1024) {
  invariant(typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value), "RECOVERY_ENCODING", `invalid ${field}`);
  const out = Buffer.from(value, "base64url");
  invariant(out.length >= min && out.length <= max, "RECOVERY_LENGTH", `invalid ${field} length`);
  return out;
}

function validateKey(key) {
  invariant(Buffer.isBuffer(key) || key instanceof Uint8Array, "RECOVERY_KEY_TYPE", "recovery key must be bytes");
  invariant(key.byteLength === 32, "RECOVERY_KEY_LENGTH", "recovery key must be exactly 32 bytes");
  return Buffer.from(key);
}

export function createRecoveryArtifact(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "RECOVERY_ARTIFACT_TYPE", "recovery artifact required");
  assertNoForbiddenSecrets(input);
  const allowed = new Set(["artifactType","chainProfile","encoding","data"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "RECOVERY_ARTIFACT_UNKNOWN_FIELD", `unknown recovery artifact field: ${key}`);

  invariant(ARTIFACT_TYPES.has(input.artifactType), "RECOVERY_ARTIFACT_KIND", "unsupported recovery artifact type");
  invariant(typeof input.chainProfile === "string" && input.chainProfile.length >= 3 && input.chainProfile.length <= 128, "RECOVERY_ARTIFACT_CHAIN", "invalid recovery artifact chain");
  invariant(ENCODINGS.has(input.encoding), "RECOVERY_ARTIFACT_ENCODING", "unsupported recovery artifact encoding");
  invariant(typeof input.data === "string" && input.data.length >= 1 && input.data.length <= 2_000_000, "RECOVERY_ARTIFACT_DATA", "invalid recovery artifact data");

  if (input.encoding === "HEX") invariant(/^(?:[0-9a-fA-F]{2})+$/.test(input.data), "RECOVERY_ARTIFACT_HEX", "invalid hex artifact");
  if (input.encoding === "BASE64") invariant(/^[A-Za-z0-9+/]*={0,2}$/.test(input.data), "RECOVERY_ARTIFACT_BASE64", "invalid base64 artifact");

  return Object.freeze({
    artifactType: input.artifactType,
    chainProfile: input.chainProfile,
    encoding: input.encoding,
    data: input.data
  });
}

export function createRecoveryPayload(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "RECOVERY_PAYLOAD_TYPE", "recovery payload required");
  const allowed = new Set(["metadata","artifacts"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "RECOVERY_PAYLOAD_UNKNOWN_FIELD", `unknown recovery payload field: ${key}`);

  const metadata = createRecoveryMetadata(input.metadata);
  invariant(Array.isArray(input.artifacts) && input.artifacts.length >= 1 && input.artifacts.length <= 32, "RECOVERY_ARTIFACTS", "invalid recovery artifacts list");
  const artifacts = input.artifacts.map(createRecoveryArtifact);
  for (const artifact of artifacts) {
    invariant(metadata.chainProfiles.includes(artifact.chainProfile), "RECOVERY_ARTIFACT_PROFILE", "artifact references undeclared chain profile");
  }

  return Object.freeze({
    domain: RECOVERY_DOMAIN,
    payloadVersion: 1,
    metadata,
    artifacts: Object.freeze(artifacts)
  });
}

function recoveryAad() {
  return canonicalBytes({
    domain: RECOVERY_DOMAIN,
    envelopeVersion: 1,
    cipher: RECOVERY_CIPHER
  });
}

export function encryptRecoveryPayload(payloadInput, keyInput) {
  const payload = createRecoveryPayload(payloadInput);
  const key = validateKey(keyInput);
  const iv = randomBytes(12);
  const aad = recoveryAad();
  const plaintext = canonicalBytes(payload);

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Object.freeze({
      domain: RECOVERY_DOMAIN,
      envelopeVersion: 1,
      cipher: RECOVERY_CIPHER,
      nonce: b64url(iv),
      ciphertext: b64url(ciphertext),
      tag: b64url(tag),
      aadHash: createHash("sha256").update(aad).digest("hex")
    });
  } finally {
    key.fill(0);
  }
}

export function decryptRecoveryEnvelope(envelope, keyInput) {
  invariant(envelope && typeof envelope === "object" && !Array.isArray(envelope), "RECOVERY_ENVELOPE_TYPE", "recovery envelope required");
  const allowed = new Set(["domain","envelopeVersion","cipher","nonce","ciphertext","tag","aadHash"]);
  for (const key of Object.keys(envelope)) invariant(allowed.has(key), "RECOVERY_ENVELOPE_UNKNOWN_FIELD", `unknown recovery envelope field: ${key}`);

  invariant(envelope.domain === RECOVERY_DOMAIN, "RECOVERY_ENVELOPE_DOMAIN", "invalid recovery envelope domain");
  invariant(envelope.envelopeVersion === 1, "RECOVERY_ENVELOPE_VERSION", "unsupported recovery envelope version");
  invariant(envelope.cipher === RECOVERY_CIPHER, "RECOVERY_ENVELOPE_CIPHER", "unsupported recovery cipher");

  const key = validateKey(keyInput);
  const iv = fromB64url(envelope.nonce, "nonce", 12, 12);
  const ciphertext = fromB64url(envelope.ciphertext, "ciphertext", 1);
  const tag = fromB64url(envelope.tag, "tag", 16, 16);
  const aad = recoveryAad();
  const aadHash = createHash("sha256").update(aad).digest("hex");
  invariant(envelope.aadHash === aadHash, "RECOVERY_AAD_HASH", "recovery AAD mismatch");

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    invariant(plaintext.length <= 8 * 1024 * 1024, "RECOVERY_PLAINTEXT_LIMIT", "recovery plaintext too large");

    let parsed;
    try { parsed = JSON.parse(plaintext.toString("utf8")); }
    catch { invariant(false, "RECOVERY_JSON", "recovery plaintext is not valid JSON"); }

    invariant(parsed.domain === RECOVERY_DOMAIN && parsed.payloadVersion === 1, "RECOVERY_PAYLOAD_HEADER", "invalid recovery payload header");
    return createRecoveryPayload({ metadata: parsed.metadata, artifacts: parsed.artifacts });
  } finally {
    key.fill(0);
  }
}
