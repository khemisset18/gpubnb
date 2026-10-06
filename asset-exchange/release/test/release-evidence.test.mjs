import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRequiredReleaseGatesV1,
  createReleaseEvidenceManifestV1,
  releaseEvidenceDigestHex
} from "../src/release-evidence.mjs";

const sourceCommit = "a".repeat(40);
const base = {
  releaseId: "asset-exchange-regtest-candidate-001",
  stage: "REGTEST_CANDIDATE",
  sourceCommit,
  sourceDateEpoch: 1791320000,
  protocols: [
    { name: "bitcoin-p2wsh-htlc", version: "v1" },
    { name: "recovery-bundle", version: "v1" }
  ],
  migrations: ["001_foundation.sql","002_atomic_offer_operations.sql"],
  artifacts: [{
    name: "gpu.k.p2p-recovery-tool-v1.tar.gz",
    sha256: "1".repeat(64),
    sbomSha256: "2".repeat(64),
    provenanceAttestationId: "53317568",
    sbomAttestationId: "53317576"
  }],
  gates: [
    {
      gateId: "g5-foundation",
      workflowPath: ".github/workflows/asset-exchange-foundation.yml",
      runId: 101,
      headSha: sourceCommit,
      conclusion: "success"
    },
    {
      gateId: "bitcoin-regtest",
      workflowPath: ".github/workflows/asset-exchange-bitcoin-regtest.yml",
      runId: 102,
      headSha: sourceCommit,
      conclusion: "success"
    }
  ],
  knownLimitations: [
    "Mainnet remains blocked pending independent external audit.",
    "Transactional signet qualification is not yet complete."
  ],
  recoveryFormatVersion: 1,
  bitcoinCoreVersion: "31.1",
  mainnetAuthorized: false,
  realFundsAuthorized: false
};

test("release evidence normalizes unordered lists and has a stable digest", () => {
  const a = createReleaseEvidenceManifestV1(base);
  const b = createReleaseEvidenceManifestV1({
    ...base,
    protocols: [...base.protocols].reverse(),
    gates: [...base.gates].reverse(),
    migrations: [...base.migrations].reverse(),
    knownLimitations: [...base.knownLimitations].reverse()
  });
  assert.deepEqual(a, b);
  assert.equal(releaseEvidenceDigestHex(a), releaseEvidenceDigestHex(b));
});

test("every gate must be green on the exact source SHA", () => {
  assert.throws(() => createReleaseEvidenceManifestV1({
    ...base,
    gates: [{ ...base.gates[0], headSha: "b".repeat(40) }]
  }));
  assert.throws(() => createReleaseEvidenceManifestV1({
    ...base,
    gates: [{ ...base.gates[0], conclusion: "failure" }]
  }));
});

test("V1 evidence cannot authorize Mainnet or real funds", () => {
  assert.throws(() => createReleaseEvidenceManifestV1({ ...base, mainnetAuthorized: true }));
  assert.throws(() => createReleaseEvidenceManifestV1({ ...base, realFundsAuthorized: true }));
});

test("required gate policy is explicit and fail-closed", () => {
  assert.equal(assertRequiredReleaseGatesV1(base, ["g5-foundation","bitcoin-regtest"]), true);
  assert.throws(() => assertRequiredReleaseGatesV1(base, ["g5-foundation","formal-verification"]));
});

test("artifact and limitation changes alter evidence digest", () => {
  const digest = releaseEvidenceDigestHex(base);
  assert.notEqual(releaseEvidenceDigestHex({
    ...base,
    artifacts: [{ ...base.artifacts[0], sha256: "3".repeat(64) }]
  }), digest);
  assert.notEqual(releaseEvidenceDigestHex({
    ...base,
    knownLimitations: [...base.knownLimitations, "Release environment protection is not yet verified."]
  }), digest);
});

test("duplicates and generic workflows are rejected", () => {
  assert.throws(() => createReleaseEvidenceManifestV1({
    ...base,
    artifacts: [base.artifacts[0], base.artifacts[0]]
  }));
  assert.throws(() => createReleaseEvidenceManifestV1({
    ...base,
    gates: [{ ...base.gates[0], workflowPath: ".github/workflows/ci.yml" }]
  }));
});
