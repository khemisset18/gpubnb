import { createHash, randomUUID } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { createFeePolicy } from "../../core/src/fee-policy.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

export const ADMIN_DOMAIN = "GPUBNB:ASSET-EXCHANGE:ADMIN:v1";

function hashHex(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

export function createFeePolicyAdminIntent(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "ADMIN_INTENT_TYPE", "admin intent required");
  const allowed = new Set([
    "domain","version","action",
    "deploymentId","actorSubject","currentMode","currentPolicyEpoch","currentConfigHash",
    "policy","challengeId","issuedAtUnixMs","expiresAtUnixMs"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "ADMIN_INTENT_UNKNOWN_FIELD", `unknown admin intent field: ${key}`);

  if (input.domain !== undefined) invariant(input.domain === ADMIN_DOMAIN, "ADMIN_DOMAIN", "invalid admin domain");
  if (input.version !== undefined) invariant(input.version === 1, "ADMIN_VERSION", "unsupported admin version");
  if (input.action !== undefined) invariant(input.action === "ACTIVATE_FEE_POLICY", "ADMIN_ACTION", "unsupported admin action");
  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof input.actorSubject === "string" && input.actorSubject.length >= 3 && input.actorSubject.length <= 256, "ADMIN_ACTOR", "invalid admin actor");
  invariant(["CONFORMITE","SOUVERAIN"].includes(input.currentMode), "ADMIN_MODE", "fee changes unavailable during transition");
  invariant(Number.isSafeInteger(input.currentPolicyEpoch) && input.currentPolicyEpoch >= 0, "ADMIN_EPOCH", "invalid policy epoch");
  invariant(typeof input.currentConfigHash === "string" && /^[0-9a-f]{64}$/.test(input.currentConfigHash), "ADMIN_CONFIG_HASH", "invalid config hash");
  invariant(typeof input.challengeId === "string" && /^[A-Za-z0-9._:-]{16,128}$/.test(input.challengeId), "ADMIN_CHALLENGE_ID", "invalid challenge id");
  invariant(Number.isSafeInteger(input.issuedAtUnixMs) && input.issuedAtUnixMs > 0, "ADMIN_IAT", "invalid issued at");
  invariant(Number.isSafeInteger(input.expiresAtUnixMs) && input.expiresAtUnixMs > input.issuedAtUnixMs, "ADMIN_EXP", "invalid expiry");

  const policy = createFeePolicy(input.policy);

  return Object.freeze({
    domain: ADMIN_DOMAIN,
    version: 1,
    action: "ACTIVATE_FEE_POLICY",
    deploymentId,
    actorSubject: input.actorSubject,
    currentMode: input.currentMode,
    currentPolicyEpoch: input.currentPolicyEpoch,
    currentConfigHash: input.currentConfigHash,
    policy,
    challengeId: input.challengeId,
    issuedAtUnixMs: input.issuedAtUnixMs,
    expiresAtUnixMs: input.expiresAtUnixMs
  });
}

export function createAdminFeeService({
  repository,
  verifyStrongAdminAssertion,
  authorizeAdminSubject,
  challengeStore,
  deploymentId,
  maxOperatorRateBps = 10_000,
  challengeTtlMs = 120_000,
  now = () => Date.now()
}) {
  invariant(repository && typeof repository.getOperatorState === "function" && typeof repository.activateFeePolicyAtomic === "function", "ADMIN_REPOSITORY", "admin repository required");
  invariant(typeof verifyStrongAdminAssertion === "function", "ADMIN_ASSERTION_VERIFIER", "strong admin assertion verifier required");
  invariant(typeof authorizeAdminSubject === "function", "ADMIN_AUTHORIZER", "admin subject authorizer required");
  invariant(challengeStore && typeof challengeStore.put === "function" && typeof challengeStore.consume === "function", "ADMIN_CHALLENGE_STORE", "challenge store required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);
  invariant(Number.isSafeInteger(maxOperatorRateBps) && maxOperatorRateBps >= 0 && maxOperatorRateBps <= 10_000, "ADMIN_MAX_RATE", "invalid operator max rate");
  invariant(Number.isSafeInteger(challengeTtlMs) && challengeTtlMs >= 30_000 && challengeTtlMs <= 300_000, "ADMIN_CHALLENGE_TTL", "invalid challenge ttl");

  return Object.freeze({
    async createFeeChallenge({ actorSubject, proposedPolicy }) {
      const authorized = await authorizeAdminSubject({ actorSubject, action: "ACTIVATE_FEE_POLICY" });
      invariant(authorized === true, "ADMIN_NOT_AUTHORIZED", "actor is not authorized for admin action");
      const operator = await repository.getOperatorState();
      invariant(operator.mode !== "TRANSITION", "ADMIN_TRANSITION_BLOCKED", "admin fee change blocked during transition");
      const policy = createFeePolicy(proposedPolicy, { maxRateBps: maxOperatorRateBps });

      const issuedAtUnixMs = now();
      const intent = createFeePolicyAdminIntent({
        deploymentId: scopedDeploymentId,
        actorSubject,
        currentMode: operator.mode,
        currentPolicyEpoch: operator.policyEpoch,
        currentConfigHash: operator.configHash,
        policy,
        challengeId: randomUUID(),
        issuedAtUnixMs,
        expiresAtUnixMs: issuedAtUnixMs + challengeTtlMs
      });
      const challengeHash = hashHex(intent);
      await challengeStore.put(intent.challengeId, {
        challengeHash,
        actorSubject,
        expiresAtUnixMs: intent.expiresAtUnixMs
      });
      return Object.freeze({ intent, challengeHash });
    },

    async activateFeePolicy({ intent, assertion }) {
      const parsed = createFeePolicyAdminIntent(intent);
      invariant(parsed.deploymentId === scopedDeploymentId, "ADMIN_DEPLOYMENT_MISMATCH", "wrong deployment");
      const authorized = await authorizeAdminSubject({ actorSubject: parsed.actorSubject, action: parsed.action });
      invariant(authorized === true, "ADMIN_NOT_AUTHORIZED", "actor is not authorized for admin action");
      const currentTime = now();
      invariant(parsed.expiresAtUnixMs > currentTime, "ADMIN_CHALLENGE_EXPIRED", "admin challenge expired");
      const challengeHash = hashHex(parsed);

      const consumed = await challengeStore.consume(parsed.challengeId, challengeHash, parsed.actorSubject);
      invariant(consumed === true, "ADMIN_CHALLENGE_REPLAY", "admin challenge invalid or already consumed");

      const verification = await verifyStrongAdminAssertion({
        actorSubject: parsed.actorSubject,
        challengeHash,
        intent: parsed,
        assertion
      });
      invariant(verification?.verified === true, "ADMIN_ASSERTION_INVALID", "strong admin assertion failed");
      invariant(typeof verification.credentialId === "string" && verification.credentialId.length >= 8 && verification.credentialId.length <= 512, "ADMIN_CREDENTIAL_ID", "invalid credential id");
      invariant(verification.userVerified === true, "ADMIN_USER_VERIFICATION", "user verification required");

      const policyHash = hashHex(parsed.policy);
      const afterConfigHash = hashHex({
        previousConfigHash: parsed.currentConfigHash,
        action: parsed.action,
        policyHash,
        challengeHash
      });

      return repository.activateFeePolicyAtomic({
        deploymentId: scopedDeploymentId,
        actorSubject: parsed.actorSubject,
        credentialId: verification.credentialId,
        challengeHash,
        expectedConfigHash: parsed.currentConfigHash,
        policy: parsed.policy,
        policyHash,
        afterConfigHash,
        auditId: randomUUID()
      });
    }
  });
}

export function createMemoryAdminChallengeStore() {
  const rows = new Map();
  return Object.freeze({
    async put(id, value) { rows.set(id, structuredClone(value)); },
    async consume(id, challengeHash, actorSubject) {
      const row = rows.get(id);
      if (!row) return false;
      if (row.challengeHash !== challengeHash || row.actorSubject !== actorSubject) return false;
      rows.delete(id);
      return true;
    }
  });
}
