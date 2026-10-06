import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";

export const RELEASE_EVIDENCE_DOMAIN = "GPUBNB:ASSET-EXCHANGE:RELEASE-EVIDENCE:v1";

const STAGES = new Set(["REGTEST_CANDIDATE","SIGNET_READONLY","SIGNET_TRANSACTION","AUDITED_CANARY_CANDIDATE"]);

function token(value, field, min = 3, max = 160) {
  invariant(
    typeof value === "string" &&
      value.length >= min &&
      value.length <= max &&
      /^[a-z0-9][a-z0-9._:-]*$/.test(value),
    "RELEASE_TOKEN",
    `invalid ${field}`
  );
  return value;
}

function sha256(value, field) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "RELEASE_SHA256", `invalid ${field}`);
  return value;
}

function sourceSha(value, field = "sourceCommit") {
  invariant(typeof value === "string" && /^[0-9a-f]{40}$/.test(value), "RELEASE_SOURCE_SHA", `invalid ${field}`);
  return value;
}

function assertUnique(values, keyFn, code, message) {
  const keys = values.map(keyFn);
  invariant(new Set(keys).size === keys.length, code, message);
}

function normalizeProtocols(input) {
  invariant(Array.isArray(input) && input.length >= 1 && input.length <= 64, "RELEASE_PROTOCOLS", "protocol list required");
  const out = input.map((item) => {
    invariant(item && typeof item === "object" && !Array.isArray(item), "RELEASE_PROTOCOL", "protocol record required");
    invariant(Object.keys(item).every((k) => k === "name" || k === "version"), "RELEASE_PROTOCOL_FIELD", "unknown protocol field");
    return Object.freeze({ name: token(item.name, "protocol name"), version: token(item.version, "protocol version", 1, 64) });
  });
  assertUnique(out, (v) => v.name, "RELEASE_PROTOCOL_DUPLICATE", "duplicate protocol name");
  return Object.freeze([...out].sort((a,b) => a.name.localeCompare(b.name)));
}

function normalizeMigrations(input) {
  invariant(Array.isArray(input) && input.length <= 256, "RELEASE_MIGRATIONS", "migration list required");
  const out = input.map((v) => token(v, "migration id", 1, 160));
  invariant(new Set(out).size === out.length, "RELEASE_MIGRATION_DUPLICATE", "duplicate migration id");
  return Object.freeze([...out].sort());
}

function normalizeArtifacts(input) {
  invariant(Array.isArray(input) && input.length >= 1 && input.length <= 128, "RELEASE_ARTIFACTS", "artifact list required");
  const out = input.map((item) => {
    invariant(item && typeof item === "object" && !Array.isArray(item), "RELEASE_ARTIFACT", "artifact record required");
    const allowed = new Set(["name","sha256","sbomSha256","provenanceAttestationId","sbomAttestationId"]);
    for (const key of Object.keys(item)) invariant(allowed.has(key), "RELEASE_ARTIFACT_FIELD", `unknown artifact field: ${key}`);

    const value = {
      name: token(item.name, "artifact name", 3, 160),
      sha256: sha256(item.sha256, "artifact sha256")
    };
    if (item.sbomSha256 !== undefined) value.sbomSha256 = sha256(item.sbomSha256, "SBOM sha256");
    for (const field of ["provenanceAttestationId","sbomAttestationId"]) {
      if (item[field] !== undefined) {
        invariant(
          typeof item[field] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(item[field]),
          "RELEASE_ATTESTATION_ID",
          `invalid ${field}`
        );
        value[field] = item[field];
      }
    }
    return Object.freeze(value);
  });
  assertUnique(out, (v) => v.name, "RELEASE_ARTIFACT_DUPLICATE", "duplicate artifact name");
  return Object.freeze([...out].sort((a,b) => a.name.localeCompare(b.name)));
}

function normalizeGates(input, sourceCommit) {
  invariant(Array.isArray(input) && input.length >= 1 && input.length <= 128, "RELEASE_GATES", "gate list required");
  const out = input.map((item) => {
    invariant(item && typeof item === "object" && !Array.isArray(item), "RELEASE_GATE", "gate record required");
    const allowed = new Set(["gateId","workflowPath","runId","headSha","conclusion"]);
    for (const key of Object.keys(item)) invariant(allowed.has(key), "RELEASE_GATE_FIELD", `unknown gate field: ${key}`);

    const gateId = token(item.gateId, "gate id");
    invariant(
      typeof item.workflowPath === "string" &&
        item.workflowPath.startsWith(".github/workflows/asset-exchange-") &&
        item.workflowPath.endsWith(".yml") &&
        !item.workflowPath.includes(".."),
      "RELEASE_GATE_WORKFLOW",
      "gate must use a dedicated Asset Exchange workflow"
    );
    invariant(Number.isSafeInteger(item.runId) && item.runId >= 1, "RELEASE_GATE_RUN", "invalid gate run id");
    const headSha = sourceSha(item.headSha, "gate headSha");
    invariant(headSha === sourceCommit, "RELEASE_GATE_SOURCE_MISMATCH", `gate ${gateId} is from a different source commit`);
    invariant(item.conclusion === "success", "RELEASE_GATE_NOT_GREEN", `gate ${gateId} is not successful`);

    return Object.freeze({
      gateId,
      workflowPath: item.workflowPath,
      runId: item.runId,
      headSha,
      conclusion: "success"
    });
  });
  assertUnique(out, (v) => v.gateId, "RELEASE_GATE_DUPLICATE", "duplicate gate id");
  return Object.freeze([...out].sort((a,b) => a.gateId.localeCompare(b.gateId)));
}

function normalizeLimitations(input) {
  invariant(Array.isArray(input) && input.length >= 1 && input.length <= 128, "RELEASE_LIMITATIONS", "known limitations must be explicit");
  const out = input.map((value) => {
    invariant(
      typeof value === "string" &&
        value.length >= 8 &&
        value.length <= 500 &&
        !/[\r\n]/.test(value),
      "RELEASE_LIMITATION",
      "invalid known limitation"
    );
    return value;
  });
  invariant(new Set(out).size === out.length, "RELEASE_LIMITATION_DUPLICATE", "duplicate known limitation");
  return Object.freeze([...out].sort());
}

export function createReleaseEvidenceManifestV1(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "RELEASE_MANIFEST_TYPE", "release evidence manifest required");
  const allowed = new Set([
    "domain","version","releaseId","stage","sourceCommit","sourceDateEpoch",
    "protocols","migrations","artifacts","gates","knownLimitations",
    "recoveryFormatVersion","bitcoinCoreVersion","mainnetAuthorized","realFundsAuthorized"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "RELEASE_MANIFEST_UNKNOWN_FIELD", `unknown release manifest field: ${key}`);

  if (input.domain !== undefined) invariant(input.domain === RELEASE_EVIDENCE_DOMAIN, "RELEASE_MANIFEST_DOMAIN", "invalid release domain");
  if (input.version !== undefined) invariant(input.version === 1, "RELEASE_MANIFEST_VERSION", "unsupported release evidence version");

  const releaseId = token(input.releaseId, "release id", 8, 128);
  invariant(STAGES.has(input.stage), "RELEASE_STAGE", "unsupported release stage");
  const sourceCommit = sourceSha(input.sourceCommit);
  invariant(Number.isSafeInteger(input.sourceDateEpoch) && input.sourceDateEpoch >= 1, "RELEASE_SOURCE_DATE", "sourceDateEpoch required");
  invariant(input.mainnetAuthorized === false, "RELEASE_MAINNET_BLOCKED", "V1 evidence cannot authorize Mainnet");
  invariant(input.realFundsAuthorized === false, "RELEASE_REAL_FUNDS_BLOCKED", "V1 evidence cannot authorize real funds");
  invariant(Number.isSafeInteger(input.recoveryFormatVersion) && input.recoveryFormatVersion >= 1, "RELEASE_RECOVERY_VERSION", "invalid recovery format version");
  invariant(typeof input.bitcoinCoreVersion === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(input.bitcoinCoreVersion), "RELEASE_BITCOIN_CORE", "invalid Bitcoin Core version");

  return Object.freeze({
    domain: RELEASE_EVIDENCE_DOMAIN,
    version: 1,
    releaseId,
    stage: input.stage,
    sourceCommit,
    sourceDateEpoch: input.sourceDateEpoch,
    protocols: normalizeProtocols(input.protocols),
    migrations: normalizeMigrations(input.migrations),
    artifacts: normalizeArtifacts(input.artifacts),
    gates: normalizeGates(input.gates, sourceCommit),
    knownLimitations: normalizeLimitations(input.knownLimitations),
    recoveryFormatVersion: input.recoveryFormatVersion,
    bitcoinCoreVersion: input.bitcoinCoreVersion,
    mainnetAuthorized: false,
    realFundsAuthorized: false
  });
}

export function assertRequiredReleaseGatesV1(manifestInput, requiredGateIds) {
  const manifest = createReleaseEvidenceManifestV1(manifestInput);
  invariant(Array.isArray(requiredGateIds) && requiredGateIds.length >= 1, "RELEASE_REQUIRED_GATES", "required gate ids must be explicit");
  const required = requiredGateIds.map((id) => token(id, "required gate id"));
  invariant(new Set(required).size === required.length, "RELEASE_REQUIRED_GATE_DUPLICATE", "duplicate required gate id");

  const present = new Set(manifest.gates.map((gate) => gate.gateId));
  const missing = required.filter((id) => !present.has(id));
  invariant(missing.length === 0, "RELEASE_REQUIRED_GATE_MISSING", `missing required release gates: ${missing.join(",")}`);
  return true;
}

export function releaseEvidenceDigestHex(manifestInput) {
  const manifest = createReleaseEvidenceManifestV1(manifestInput);
  return createHash("sha256").update(canonicalBytes(manifest)).digest("hex");
}
