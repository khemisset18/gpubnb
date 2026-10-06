import test from "node:test";
import assert from "node:assert/strict";
import { createAdminFeeService, createMemoryAdminChallengeStore } from "../src/admin-fee-service.mjs";

function repository() {
  const calls = [];
  return {
    calls,
    async getOperatorState() {
      return { mode: "SOUVERAIN", policyEpoch: 7, configHash: "a".repeat(64), activeFeePolicyId: null, activeFeePolicyVersion: null };
    },
    async activateFeePolicyAtomic(input) {
      calls.push(input);
      return { status: "ACTIVE", policyId: input.policy.policyId, version: input.policy.version, rateBps: input.policy.rateBps };
    }
  };
}

const policy = {
  policyId: "owner-fee-v2",
  version: 2,
  rateBps: 75,
  payerRole: "TAKER",
  feeAssetKey: "bitcoin|regtest|NATIVE|BTC_NATIVE|8",
  recipient: "treasury:test"
};

test("owner can choose fee percentage within deployment safety maximum", async () => {
  const repo = repository();
  const svc = createAdminFeeService({
    repository: repo,
    challengeStore: createMemoryAdminChallengeStore(),
    deploymentId: "ae-test-01",
    maxOperatorRateBps: 500,
    now: () => 1000,
    verifyStrongAdminAssertion: async () => ({ verified: true, userVerified: true, credentialId: "passkey-credential-001" })
  });
  const { intent } = await svc.createFeeChallenge({ actorSubject: "owner:test:001", proposedPolicy: policy });
  const result = await svc.activateFeePolicy({ intent, assertion: { opaque: true } });
  assert.equal(result.rateBps, 75);
  assert.equal(repo.calls[0].policy.rateBps, 75);
});

test("fee above configured owner safety cap is rejected before challenge", async () => {
  const svc = createAdminFeeService({
    repository: repository(),
    challengeStore: createMemoryAdminChallengeStore(),
    deploymentId: "ae-test-01",
    maxOperatorRateBps: 500,
    verifyStrongAdminAssertion: async () => ({ verified: true, userVerified: true, credentialId: "passkey-credential-001" })
  });
  await assert.rejects(() => svc.createFeeChallenge({
    actorSubject: "owner:test:001",
    proposedPolicy: { ...policy, rateBps: 501 }
  }));
});

test("challenge is one-time and strong user verification is mandatory", async () => {
  const repo = repository();
  const challenges = createMemoryAdminChallengeStore();
  const svc = createAdminFeeService({
    repository: repo,
    challengeStore: challenges,
    deploymentId: "ae-test-01",
    now: () => 1000,
    verifyStrongAdminAssertion: async () => ({ verified: true, userVerified: true, credentialId: "passkey-credential-001" })
  });
  const { intent } = await svc.createFeeChallenge({ actorSubject: "owner:test:001", proposedPolicy: policy });
  await svc.activateFeePolicy({ intent, assertion: {} });
  await assert.rejects(() => svc.activateFeePolicy({ intent, assertion: {} }));

  const weak = createAdminFeeService({
    repository: repository(),
    challengeStore: createMemoryAdminChallengeStore(),
    deploymentId: "ae-test-01",
    now: () => 1000,
    verifyStrongAdminAssertion: async () => ({ verified: true, userVerified: false, credentialId: "passkey-credential-001" })
  });
  const next = await weak.createFeeChallenge({ actorSubject: "owner:test:001", proposedPolicy: { ...policy, policyId: "owner-fee-v3", version: 3 } });
  await assert.rejects(() => weak.activateFeePolicy({ intent: next.intent, assertion: {} }));
});
