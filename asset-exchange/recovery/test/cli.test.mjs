import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cli = new URL("../src/cli.mjs", import.meta.url).pathname;

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

function fixture() {
  return {
    metadata: {
      bundleVersion: 1,
      deploymentId: "ae-test-01",
      tradeId: "trade-recovery-0001",
      protocolId: "GPUBNB-ASSET-EXCHANGE-BTC-P2WSH-HTLC-V1",
      protocolVersion: 1,
      partyRole: "MAKER",
      chainProfiles: ["bitcoin-regtest-v1"],
      recoveryActions: ["REFUND","REBROADCAST","RECONCILE"],
      createdAtUnixMs: 2000000000000
    },
    artifacts: [{
      artifactType: "SIGNED_REFUND_TX",
      chainProfile: "bitcoin-regtest-v1",
      encoding: "HEX",
      data: "00ff"
    }]
  };
}

test("standalone recovery CLI keygen/encrypt/decrypt round-trips without plaintext bundle leakage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-recovery-cli-"));
  const key = join(dir, "recovery.key");
  const payload = join(dir, "payload.json");
  const bundle = join(dir, "bundle.json");
  const recovered = join(dir, "recovered.json");
  writeFileSync(payload, JSON.stringify(fixture()), { mode: 0o600 });

  assert.equal(run(["keygen", key]).status, 0);
  assert.equal(statSync(key).mode & 0o077, 0);

  assert.equal(run(["encrypt", key, payload, bundle]).status, 0);
  const encrypted = readFileSync(bundle, "utf8");
  assert.equal(encrypted.includes("trade-recovery-0001"), false);
  assert.equal(encrypted.includes("00ff"), false);

  assert.equal(run(["decrypt", key, bundle, recovered]).status, 0);
  const decoded = JSON.parse(readFileSync(recovered, "utf8"));
  assert.equal(decoded.metadata.tradeId, "trade-recovery-0001");
  assert.equal(decoded.artifacts[0].data, "00ff");
  assert.equal(statSync(bundle).mode & 0o077, 0);
  assert.equal(statSync(recovered).mode & 0o077, 0);
});

test("standalone recovery CLI refuses overwrite of existing key or output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ae-recovery-cli-overwrite-"));
  const key = join(dir, "key");
  writeFileSync(key, "existing", { mode: 0o600 });
  assert.notEqual(run(["keygen", key]).status, 0);
});
