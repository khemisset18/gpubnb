import { createHash } from "node:crypto";
import { invariant } from "../../core/src/errors.mjs";

export const BTC_HTLC_PROTOCOL_ID = "GPUBNB-ASSET-EXCHANGE-BTC-P2WSH-HTLC-V1";

function hexBytes(value, expectedBytes, field) {
  invariant(typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${expectedBytes * 2}}$`).test(value), "BTC_HTLC_HEX", `invalid ${field}`);
  return Buffer.from(value, "hex");
}

function compressedPubkey(value, field) {
  const key = hexBytes(value, 33, field);
  invariant(key[0] === 0x02 || key[0] === 0x03, "BTC_HTLC_PUBKEY", `${field} must be compressed secp256k1 pubkey`);
  return key;
}

export function encodeMinimalScriptNumber(value) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value < 500_000_000, "BTC_HTLC_LOCK_HEIGHT", "refund lock height must be a non-negative block height");
  if (value === 0) return Buffer.alloc(0);

  const bytes = [];
  let n = value;
  while (n > 0) {
    bytes.push(n & 0xff);
    n = Math.floor(n / 256);
  }
  if (bytes.at(-1) & 0x80) bytes.push(0x00);
  return Buffer.from(bytes);
}

function minimalPush(data) {
  invariant(Buffer.isBuffer(data), "BTC_HTLC_PUSH_TYPE", "push data must be buffer");
  if (data.length === 0) return Buffer.from([0x00]);
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return Buffer.from([0x50 + data[0]]);
  invariant(data.length <= 75, "BTC_HTLC_PUSH_SIZE", "V1 only supports direct minimal pushes");
  return Buffer.concat([Buffer.from([data.length]), data]);
}

export function buildBitcoinHtlcV1({ secretHashHex, redeemPubkeyHex, refundPubkeyHex, refundLockHeight }) {
  invariant(Number.isSafeInteger(refundLockHeight) && refundLockHeight >= 1 && refundLockHeight < 500_000_000, "BTC_HTLC_LOCK_HEIGHT", "refund lock height must be a positive block height");
  const secretHash = hexBytes(secretHashHex, 32, "secret hash");
  const redeem = compressedPubkey(redeemPubkeyHex, "redeem pubkey");
  const refund = compressedPubkey(refundPubkeyHex, "refund pubkey");
  const lock = encodeMinimalScriptNumber(refundLockHeight);

  const witnessScript = Buffer.concat([
    Buffer.from([0x63, 0x82]),
    minimalPush(Buffer.from([0x20])),
    Buffer.from([0x88, 0xa8]),
    minimalPush(secretHash),
    Buffer.from([0x88]),
    minimalPush(redeem),
    Buffer.from([0xac, 0x67]),
    minimalPush(lock),
    Buffer.from([0xb1, 0x69]),
    minimalPush(refund),
    Buffer.from([0xac, 0x68])
  ]);

  const scriptHash = createHash("sha256").update(witnessScript).digest();
  const scriptPubKey = Buffer.concat([Buffer.from([0x00, 0x20]), scriptHash]);

  return Object.freeze({
    protocolId: BTC_HTLC_PROTOCOL_ID,
    witnessScriptHex: witnessScript.toString("hex"),
    witnessScriptHashHex: scriptHash.toString("hex"),
    scriptPubKeyHex: scriptPubKey.toString("hex"),
    refundLockHeight
  });
}

export function validateRefundTransactionPolicy({ version, lockTime, sequence, sighashType }) {
  invariant(version === 2, "BTC_REFUND_VERSION", "refund transaction version must be 2");
  invariant(Number.isSafeInteger(lockTime) && lockTime >= 1 && lockTime < 500_000_000, "BTC_REFUND_LOCKTIME", "refund locktime must be positive block height");
  invariant(sequence === 0xfffffffd, "BTC_REFUND_SEQUENCE", "refund input sequence must be 0xfffffffd");
  invariant(sighashType === 0x01, "BTC_REFUND_SIGHASH", "refund must use SIGHASH_ALL");
  return true;
}
