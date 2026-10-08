import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRecoveryPayload, encryptRecoveryPayload } from "../src/bundle.mjs";
import { parseStrictJson } from "../src/strict-json.mjs";

function metadata() {
  return {
    bundleVersion: 1,
    deploymentId: "ae-test-01",
    tradeId: "trade-00000001",
    protocolId: "GPUBNB-ASSET-EXCHANGE-UTXO-HTLC-V1",
    protocolVersion: 1,
    partyRole: "MAKER",
    chainProfiles: ["bitcoin-regtest-v1"],
    recoveryActions: ["REFUND"],
    createdAtUnixMs: 2000000000000
  };
}

function artifact(overrides = {}) {
  return {
    artifactType: "LOCK_TXID",
    chainProfile: "bitcoin-regtest-v1",
    encoding: "HEX",
    data: "aa",
    ...overrides
  };
}

test("producer refuses payloads larger than the decrypt-side plaintext limit", () => {
  const data = "aa".repeat(1_000_000);
  const artifacts = Array.from({ length: 5 }, () => artifact({ artifactType: "LOCK_SCRIPT", data }));
  assert.throws(
    () => encryptRecoveryPayload({ metadata: metadata(), artifacts }, randomBytes(32)),
    (error) => error?.code === "RECOVERY_PLAINTEXT_LIMIT"
  );
});

test("JSON artifact content cannot hide forbidden custody fields", () => {
  assert.throws(
    () => createRecoveryPayload({
      metadata: metadata(),
      artifacts: [artifact({
        artifactType: "CHAIN_RECOVERY_RECIPE",
        encoding: "JSON",
        data: JSON.stringify({ privateKey: "forbidden" })
      })]
    }),
    (error) => error?.code === "RECOVERY_FORBIDDEN_SECRET_FIELD"
  );
});

test("artifact BASE64 must be syntactically valid and canonical", () => {
  assert.throws(() => createRecoveryPayload({
    metadata: metadata(),
    artifacts: [artifact({ artifactType: "REFUND_PSBT", encoding: "BASE64", data: "A" })]
  }));
});

test("recovery identifiers reject control and bidi characters", () => {
  const m = metadata();
  m.tradeId = "trade-01\nDISPLAY-INJECTION";
  assert.throws(() => createRecoveryPayload({ metadata: m, artifacts: [artifact()] }));
});

test("CLI rejects duplicate JSON object keys instead of last-key-wins parsing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-recovery-dup-"));
  const key = join(dir, "key");
  const payload = join(dir, "payload.json");
  const bundle = join(dir, "bundle.json");
  const cli = new URL("../src/cli.mjs", import.meta.url).pathname;
  const keygen = spawnSync(process.execPath, [cli, "keygen", key], { encoding: "utf8" });
  assert.equal(keygen.status, 0);
  writeFileSync(payload, `{
    "metadata": {
      "bundleVersion": 1,
      "deploymentId": "ae-test-01",
      "tradeId": "ATTACKER-FIRST",
      "tradeId": "trade-00000001",
      "protocolId": "GPUBNB-ASSET-EXCHANGE-UTXO-HTLC-V1",
      "protocolVersion": 1,
      "partyRole": "MAKER",
      "chainProfiles": ["bitcoin-regtest-v1"],
      "recoveryActions": ["REFUND"],
      "createdAtUnixMs": 2000000000000
    },
    "artifacts": [{"artifactType":"LOCK_TXID","chainProfile":"bitcoin-regtest-v1","encoding":"HEX","data":"aa"}]
  }`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [cli, "encrypt", key, payload, bundle], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(bundle), false);
});

test("CLI refuses recovery key files readable by group or world", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "ae-recovery-keyperm-"));
  const key = join(dir, "key");
  const payload = join(dir, "payload.json");
  const bundle = join(dir, "bundle.json");
  writeFileSync(key, randomBytes(32).toString("base64url") + "\n", { mode: 0o644 });
  writeFileSync(payload, JSON.stringify({ metadata: metadata(), artifacts: [artifact()] }), { mode: 0o600 });
  const cli = new URL("../src/cli.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, "encrypt", key, payload, bundle], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(bundle), false);
});

test("strict JSON accepts only RFC JSON whitespace", () => {
  assert.deepEqual(parseStrictJson(' {"a":1}\n'), { a: 1 });
  assert.throws(() => parseStrictJson('\u00a0{"a":1}'));
});
