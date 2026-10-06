import test from "node:test";
import assert from "node:assert/strict";
import { buildBitcoinHtlcV1, encodeMinimalScriptNumber, validateRefundTransactionPolicy } from "../src/bitcoin-htlc-v1.mjs";

const redeem = "02" + "11".repeat(32);
const refund = "03" + "22".repeat(32);
const secretHash = "33".repeat(32);

test("minimal script number encoding is deterministic at sign-bit boundaries", () => {
  assert.equal(encodeMinimalScriptNumber(0).toString("hex"), "");
  assert.equal(encodeMinimalScriptNumber(1).toString("hex"), "01");
  assert.equal(encodeMinimalScriptNumber(16).toString("hex"), "10");
  assert.equal(encodeMinimalScriptNumber(127).toString("hex"), "7f");
  assert.equal(encodeMinimalScriptNumber(128).toString("hex"), "8000");
  assert.equal(encodeMinimalScriptNumber(255).toString("hex"), "ff00");
  assert.equal(encodeMinimalScriptNumber(256).toString("hex"), "0001");
});

test("P2WSH HTLC builder produces exact reviewed opcode structure", () => {
  const out = buildBitcoinHtlcV1({
    secretHashHex: secretHash,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: 500
  });

  assert.match(out.witnessScriptHex, /^6382012088a820/);
  assert.ok(out.witnessScriptHex.includes("88" + "21" + redeem + "ac67"));
  assert.ok(out.witnessScriptHex.endsWith("21" + refund + "ac68"));
  assert.match(out.scriptPubKeyHex, /^0020[0-9a-f]{64}$/);
  assert.equal(out.scriptPubKeyHex.slice(4), out.witnessScriptHashHex);
});

test("builder rejects uncompressed keys, bad hashes and time-based locktimes", () => {
  assert.throws(() => buildBitcoinHtlcV1({
    secretHashHex: "aa",
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: 500
  }));
  assert.throws(() => buildBitcoinHtlcV1({
    secretHashHex: secretHash,
    redeemPubkeyHex: "04" + "11".repeat(32),
    refundPubkeyHex: refund,
    refundLockHeight: 500
  }));
  assert.throws(() => buildBitcoinHtlcV1({
    secretHashHex: secretHash,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: 500_000_000
  }));
});

test("refund transaction policy requires CLTV-active RBF sequence and SIGHASH_ALL", () => {
  assert.equal(validateRefundTransactionPolicy({
    version: 2,
    lockTime: 500,
    sequence: 0xfffffffd,
    sighashType: 0x01
  }), true);

  assert.throws(() => validateRefundTransactionPolicy({ version: 2, lockTime: 500, sequence: 0xffffffff, sighashType: 0x01 }));
  assert.throws(() => validateRefundTransactionPolicy({ version: 2, lockTime: 500, sequence: 0xfffffffd, sighashType: 0x02 }));
});

test("redeem branch enforces 32-byte preimage on-chain before hashing", () => {
  const out = buildBitcoinHtlcV1({
    secretHashHex: secretHash,
    redeemPubkeyHex: redeem,
    refundPubkeyHex: refund,
    refundLockHeight: 500
  });
  assert.match(out.witnessScriptHex, /^6382012088a8/);
});
