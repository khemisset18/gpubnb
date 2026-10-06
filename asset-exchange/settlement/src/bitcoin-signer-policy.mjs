import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

export const BTC_SIGNER_INTENT_DOMAIN = "GPUBNB:ASSET-EXCHANGE:SIGNER:BTC:v1";

function satsString(value, field, { allowZero = false } = {}) {
  invariant(typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value), "BTC_SIGNER_SATS", `invalid ${field}`);
  const n = BigInt(value);
  invariant(allowZero ? n >= 0n : n > 0n, "BTC_SIGNER_SATS_RANGE", `${field} out of range`);
  invariant(n <= 2_100_000_000_000_000n, "BTC_SIGNER_SATS_RANGE", `${field} out of range`);
  return n;
}

function hex(value, bytes, field) {
  invariant(typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value), "BTC_SIGNER_HEX", `invalid ${field}`);
  return value;
}

function txid(value, field) {
  return hex(value, 32, field);
}

function fingerprint(value) {
  invariant(typeof value === "string" && /^[0-9a-f]{8}$/.test(value), "BTC_SIGNER_FINGERPRINT", "signer fingerprint must be 8 lowercase hex chars");
  return value;
}

function outputItem(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "BTC_SIGNER_OUTPUT", "output item required");
  const allowed = new Set(["scriptPubKeyHex","amountSats","purpose"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "BTC_SIGNER_OUTPUT_FIELD", `unknown output field: ${key}`);
  invariant(typeof input.scriptPubKeyHex === "string" && /^[0-9a-f]{4,10000}$/.test(input.scriptPubKeyHex) && input.scriptPubKeyHex.length % 2 === 0, "BTC_SIGNER_SPK", "invalid output scriptPubKey");
  const amount = satsString(input.amountSats, "output amount", { allowZero: true });
  invariant(["PRINCIPAL","CHANGE","REFUND","REDEEM","PLATFORM_FEE"].includes(input.purpose), "BTC_SIGNER_OUTPUT_PURPOSE", "invalid output purpose");
  return Object.freeze({ scriptPubKeyHex: input.scriptPubKeyHex, amountSats: amount.toString(), purpose: input.purpose });
}

function inputItem(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "BTC_SIGNER_INPUT", "input item required");
  const allowed = new Set(["txid","vout","amountSats","scriptPubKeyHex","sequence"]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "BTC_SIGNER_INPUT_FIELD", `unknown input field: ${key}`);
  invariant(Number.isSafeInteger(input.vout) && input.vout >= 0 && input.vout <= 0xffffffff, "BTC_SIGNER_VOUT", "invalid vout");
  invariant(Number.isSafeInteger(input.sequence) && input.sequence >= 0 && input.sequence <= 0xffffffff, "BTC_SIGNER_SEQUENCE", "invalid sequence");
  invariant(typeof input.scriptPubKeyHex === "string" && /^[0-9a-f]{4,10000}$/.test(input.scriptPubKeyHex) && input.scriptPubKeyHex.length % 2 === 0, "BTC_SIGNER_INPUT_SPK", "invalid input scriptPubKey");
  const amount = satsString(input.amountSats, "input amount");
  return Object.freeze({
    txid: txid(input.txid, "input txid"),
    vout: input.vout,
    amountSats: amount.toString(),
    scriptPubKeyHex: input.scriptPubKeyHex,
    sequence: input.sequence
  });
}

export function createBitcoinSignerIntent(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "BTC_SIGNER_INTENT_TYPE", "signer intent required");
  const allowed = new Set([
    "deploymentId","tradeId","role","network","signerFingerprint","settlementTermsDigestHex",
    "psbtDigestHex","txVersion","lockTime","sighashType","inputs","outputs","feeSats","maxFeeSats"
  ]);
  for (const key of Object.keys(input)) invariant(allowed.has(key), "BTC_SIGNER_INTENT_FIELD", `unknown signer intent field: ${key}`);

  const deploymentId = validateDeploymentId(input.deploymentId);
  invariant(typeof input.tradeId === "string" && input.tradeId.length >= 8 && input.tradeId.length <= 128, "BTC_SIGNER_TRADE", "invalid trade id");
  invariant(["FUNDING","REDEEM","REFUND"].includes(input.role), "BTC_SIGNER_ROLE", "invalid signer role");
  invariant(input.network === "regtest", "BTC_SIGNER_NETWORK", "V1 signer policy is regtest-only");
  const signerFingerprint = fingerprint(input.signerFingerprint);
  const settlementTermsDigestHex = hex(input.settlementTermsDigestHex, 32, "settlement digest");
  const psbtDigestHex = hex(input.psbtDigestHex, 32, "psbt digest");
  invariant(input.txVersion === 2, "BTC_SIGNER_TX_VERSION", "transaction version must be 2");
  invariant(Number.isSafeInteger(input.lockTime) && input.lockTime >= 0 && input.lockTime <= 0xffffffff, "BTC_SIGNER_LOCKTIME", "invalid locktime");
  invariant(input.sighashType === 0x01, "BTC_SIGNER_SIGHASH", "V1 signer policy requires SIGHASH_ALL");
  invariant(Array.isArray(input.inputs) && input.inputs.length >= 1 && input.inputs.length <= 256, "BTC_SIGNER_INPUTS", "invalid input list");
  invariant(Array.isArray(input.outputs) && input.outputs.length >= 1 && input.outputs.length <= 256, "BTC_SIGNER_OUTPUTS", "invalid output list");

  const inputs = input.inputs.map(inputItem);
  const outputs = input.outputs.map(outputItem);
  const fee = satsString(input.feeSats, "fee", { allowZero: true });
  const maxFee = satsString(input.maxFeeSats, "max fee", { allowZero: true });
  invariant(fee <= maxFee, "BTC_SIGNER_FEE_LIMIT", "fee exceeds signer intent maximum");

  const totalIn = inputs.reduce((sum, item) => sum + BigInt(item.amountSats), 0n);
  const totalOut = outputs.reduce((sum, item) => sum + BigInt(item.amountSats), 0n);
  invariant(totalIn >= totalOut, "BTC_SIGNER_VALUE_BALANCE", "outputs exceed inputs");
  invariant(totalIn - totalOut === fee, "BTC_SIGNER_FEE_MISMATCH", "fee does not equal inputs minus outputs");

  if (input.role === "REFUND") {
    invariant(input.lockTime > 0 && inputs.every((item) => item.sequence === 0xfffffffd), "BTC_SIGNER_REFUND_POLICY", "refund requires locktime and sequence 0xfffffffd");
  }

  return Object.freeze({
    domain: BTC_SIGNER_INTENT_DOMAIN,
    version: 1,
    deploymentId,
    tradeId: input.tradeId,
    role: input.role,
    network: "regtest",
    signerFingerprint,
    settlementTermsDigestHex,
    psbtDigestHex,
    txVersion: 2,
    lockTime: input.lockTime,
    sighashType: 0x01,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    feeSats: fee.toString(),
    maxFeeSats: maxFee.toString()
  });
}

export function bitcoinSignerIntentDigestHex(input) {
  return createHash("sha256").update(canonicalBytes(createBitcoinSignerIntent(input))).digest("hex");
}

export function assertDecodedPsbtMatchesSignerIntent(decoded, intentInput) {
  const intent = createBitcoinSignerIntent(intentInput);
  invariant(decoded && typeof decoded === "object" && !Array.isArray(decoded), "BTC_SIGNER_DECODED_TYPE", "decoded PSBT required");
  invariant(decoded.tx && typeof decoded.tx === "object", "BTC_SIGNER_DECODED_TX", "decoded PSBT transaction required");
  invariant(decoded.tx.version === intent.txVersion, "BTC_SIGNER_TX_VERSION_MISMATCH", "PSBT transaction version mismatch");
  invariant(decoded.tx.locktime === intent.lockTime, "BTC_SIGNER_LOCKTIME_MISMATCH", "PSBT locktime mismatch");
  invariant(Array.isArray(decoded.inputs) && decoded.inputs.length === intent.inputs.length, "BTC_SIGNER_INPUT_COUNT", "PSBT input count mismatch");
  invariant(Array.isArray(decoded.tx.vin) && decoded.tx.vin.length === intent.inputs.length, "BTC_SIGNER_VIN_COUNT", "transaction vin count mismatch");
  invariant(Array.isArray(decoded.tx.vout) && decoded.tx.vout.length === intent.outputs.length, "BTC_SIGNER_OUTPUT_COUNT", "PSBT output count mismatch");

  for (let i = 0; i < intent.inputs.length; i += 1) {
    const expected = intent.inputs[i];
    const vin = decoded.tx.vin[i];
    const psbtInput = decoded.inputs[i];
    invariant(vin.txid === expected.txid && vin.vout === expected.vout, "BTC_SIGNER_PREVOUT_MISMATCH", `input ${i} prevout mismatch`);
    invariant(vin.sequence === expected.sequence, "BTC_SIGNER_SEQUENCE_MISMATCH", `input ${i} sequence mismatch`);
    invariant(psbtInput?.witness_utxo, "BTC_SIGNER_WITNESS_UTXO", `input ${i} missing witness_utxo`);
    invariant(psbtInput.witness_utxo.scriptPubKey?.hex === expected.scriptPubKeyHex, "BTC_SIGNER_INPUT_SCRIPT_MISMATCH", `input ${i} script mismatch`);
    const observedSats = BigInt(Math.round(Number(psbtInput.witness_utxo.amount) * 100_000_000));
    invariant(observedSats.toString() === expected.amountSats, "BTC_SIGNER_INPUT_AMOUNT_MISMATCH", `input ${i} amount mismatch`);
    if (psbtInput.sighash !== undefined) invariant(psbtInput.sighash === "ALL", "BTC_SIGNER_SIGHASH_MISMATCH", `input ${i} sighash mismatch`);
  }

  for (let i = 0; i < intent.outputs.length; i += 1) {
    const expected = intent.outputs[i];
    const observed = decoded.tx.vout[i];
    invariant(observed.scriptPubKey?.hex === expected.scriptPubKeyHex, "BTC_SIGNER_OUTPUT_SCRIPT_MISMATCH", `output ${i} script mismatch`);
    const observedSats = BigInt(Math.round(Number(observed.value) * 100_000_000));
    invariant(observedSats.toString() === expected.amountSats, "BTC_SIGNER_OUTPUT_AMOUNT_MISMATCH", `output ${i} amount mismatch`);
  }

  const psbtDigest = createHash("sha256").update(canonicalBytes(decoded)).digest("hex");
  invariant(psbtDigest === intent.psbtDigestHex, "BTC_SIGNER_PSBT_DIGEST_MISMATCH", "decoded PSBT digest mismatch");
  return true;
}
