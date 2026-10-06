import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresTradeTermsRepository } from "../src/postgres-trade-terms-repository.mjs";

function fakePool(rows) {
  const calls = [];
  const client = {
    async query(arg) {
      calls.push(arg);
      if (arg === "BEGIN" || arg === "COMMIT" || arg === "ROLLBACK") return { rows: [] };
      return { rows };
    },
    release() { calls.push("RELEASE"); }
  };
  return { calls, async connect() { return client; } };
}

test("terms repository parameterizes atomic signature submission", async () => {
  const pool = fakePool([{ status: "ACCEPTED_PENDING_TERMS", trade_id: "trade-00000001" }]);
  const repository = createPostgresTradeTermsRepository({ pool, deploymentId: "ae-test-01" });
  const result = await repository.submitTermsSignatureAtomic({
    actorSubject: "maker:test:001",
    role: "MAKER",
    tradeId: "trade-00000001",
    termsHash: "a".repeat(64),
    signature: "sig",
    idempotencyKey: "terms-maker-key-0001"
  });
  assert.equal(result.status, "ACCEPTED_PENDING_TERMS");
  const query = pool.calls.find((call) => typeof call === "object" && call.text.includes("submit_trade_terms_signature_atomic"));
  assert.equal(query.values.length, 8);
  assert.equal(query.values[0], "ae-test-01");
  assert.equal(query.values[3], "MAKER");
  assert.equal(query.values[4], "a".repeat(64));
});
