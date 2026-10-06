import test from "node:test";
import assert from "node:assert/strict";
import { createCommandEnvelope, assertCommandEpoch, commandClass } from "../src/command-envelope.mjs";

const base = {
  commandId: "command-00000001",
  tradeId: "trade-00000001",
  policyEpoch: 5,
  idempotencyKey: "idempotency-key-0001",
  requestHash: "a".repeat(64),
  createdAtUnixMs: 2000000000000
};

test("stale epochs are blocked for new commitments", () => {
  const cmd = createCommandEnvelope({ ...base, type: "BROADCAST_A_LOCK", policyEpoch: 4 });
  assert.equal(commandClass(cmd.type), "NEW_COMMITMENT");
  assert.throws(() => assertCommandEpoch(cmd, 5));
});

test("recovery remains valid across later policy epochs", () => {
  const cmd = createCommandEnvelope({ ...base, type: "REFUND", policyEpoch: 4 });
  assert.equal(commandClass(cmd.type), "RECOVERY");
  assert.equal(assertCommandEpoch(cmd, 9), true);
});

test("recovery command cannot claim a future epoch", () => {
  const cmd = createCommandEnvelope({ ...base, type: "REFUND", policyEpoch: 10 });
  assert.throws(() => assertCommandEpoch(cmd, 9));
});
