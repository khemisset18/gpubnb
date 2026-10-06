import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresAdminRepository } from "../src/postgres-admin-repository.mjs";

test("admin repository parameterizes fee activation and transaction", async () => {
  const calls = [];
  const client = {
    async query(q) {
      calls.push(q);
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [] };
      if (typeof q === "object" && q.text.includes("activate_fee_policy_atomic")) {
        return { rows: [{ status: "ACTIVE", policy_id: "owner-fee-v2", policy_version: 2, rate_bps: 75 }] };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const pool = { async connect() { return client; } };
  const repo = createPostgresAdminRepository({ pool, deploymentId: "ae-test-01" });
  const result = await repo.activateFeePolicyAtomic({
    deploymentId: "ae-test-01",
    actorSubject: "owner:test:001",
    credentialId: "passkey-credential-001",
    challengeHash: "b".repeat(64),
    expectedConfigHash: "a".repeat(64),
    policy: {
      policyId: "owner-fee-v2", version: 2, rateBps: 75, payerRole: "TAKER",
      feeAssetKey: "bitcoin|regtest|NATIVE|BTC_NATIVE|8", recipient: "treasury:test",
      minimumAtomic: null, maximumAtomic: null
    },
    policyHash: "c".repeat(64),
    afterConfigHash: "d".repeat(64),
    auditId: "audit-00000001"
  });
  assert.equal(result.rateBps, 75);
  assert.equal(calls[0], "BEGIN");
  const q = calls.find((x) => typeof x === "object" && x.text.includes("activate_fee_policy_atomic"));
  assert.equal(q.values[0], "ae-test-01");
  assert.equal(q.values[7], 75);
  assert.equal(q.values.length, 16);
  assert.match(q.text, /\$16/);
  assert.equal(calls.at(-2), "COMMIT");
  assert.equal(calls.at(-1), "RELEASE");
});
