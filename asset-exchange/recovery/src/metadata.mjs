import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

const FORBIDDEN_KEY_PATTERNS = [
  /seed/i,
  /private.?key/i,
  /spend.?key/i,
  /wallet.?password/i,
  /mnemonic/i
];

export function assertNoForbiddenSecrets(value, path = "$") {
  if (value === null || value === undefined) return true;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenSecrets(item, `${path}[${index}]`));
    return true;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      invariant(!FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key)), "RECOVERY_FORBIDDEN_SECRET_FIELD", `forbidden recovery field at ${path}.${key}`);
      assertNoForbiddenSecrets(child, `${path}.${key}`);
    }
  }

  return true;
}

function validateOpaqueId(value, field, min = 3, max = 128) {
  invariant(typeof value === "string" && value.length >= min && value.length <= max, "RECOVERY_IDENTIFIER", `invalid ${field}`);
  invariant(/^[\x21-\x7e]+$/.test(value), "RECOVERY_IDENTIFIER", `${field} must be printable ASCII without whitespace`);
  return value;
}

export function createRecoveryMetadata(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "RECOVERY_TYPE", "recovery metadata must be an object");
  assertNoForbiddenSecrets(input);

  const allowed = new Set([
    "bundleVersion","deploymentId","tradeId","protocolId","protocolVersion","partyRole","chainProfiles",
    "recoveryActions","createdAtUnixMs"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "RECOVERY_UNKNOWN_FIELD", `unknown recovery field: ${key}`);

  invariant(input.bundleVersion === 1, "RECOVERY_VERSION", "unsupported recovery bundle version");
  const deploymentId = validateDeploymentId(input.deploymentId);
  const tradeId = validateOpaqueId(input.tradeId, "tradeId", 8, 128);
  const protocolId = validateOpaqueId(input.protocolId, "protocolId", 8, 128);
  invariant(Number.isSafeInteger(input.protocolVersion) && input.protocolVersion >= 1, "RECOVERY_PROTOCOL_VERSION", "invalid protocol version");
  invariant(["MAKER","TAKER"].includes(input.partyRole), "RECOVERY_ROLE", "invalid recovery role");
  invariant(Array.isArray(input.chainProfiles) && input.chainProfiles.length >= 1 && input.chainProfiles.length <= 8, "RECOVERY_CHAINS", "invalid chain profile list");
  invariant(input.chainProfiles.every((v) => { try { validateOpaqueId(v, "chainProfile", 3, 128); return true; } catch { return false; } }), "RECOVERY_CHAIN_PROFILE", "invalid chain profile");
  invariant(Array.isArray(input.recoveryActions) && input.recoveryActions.length >= 1 && input.recoveryActions.length <= 16, "RECOVERY_ACTIONS", "invalid recovery action list");
  invariant(input.recoveryActions.every((v) => ["REFUND","REDEEM","RECONCILE","REBROADCAST"].includes(v)), "RECOVERY_ACTION", "unsupported recovery action");
  invariant(Number.isSafeInteger(input.createdAtUnixMs) && input.createdAtUnixMs > 0, "RECOVERY_TIME", "invalid creation timestamp");

  return Object.freeze({
    bundleVersion: 1,
    deploymentId,
    tradeId,
    protocolId,
    protocolVersion: input.protocolVersion,
    partyRole: input.partyRole,
    chainProfiles: Object.freeze([...input.chainProfiles]),
    recoveryActions: Object.freeze([...input.recoveryActions]),
    createdAtUnixMs: input.createdAtUnixMs
  });
}
