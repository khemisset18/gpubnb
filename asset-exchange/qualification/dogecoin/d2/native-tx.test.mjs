import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import {
  hash160, hash256, sha256, scriptPush, temporarySigner, makeHtlc,
  p2pkhOutput, signedP2shSpend, syntheticHtlcBundle, signedCoinbaseFunding,
  miningRegtestAddress, p2shRegtestAddress
} from "./native-tx.mjs";

const fixture = () => syntheticHtlcBundle(1359);
const terms = (f, branch = "CLAIM") => ({
  prevTxid: "ab".repeat(32), vout: 2, inputKoinu: 500000000n, feeKoinu: 10000000n,
  destinationScript: p2pkhOutput(f[branch === "CLAIM" ? "claim" : "refund"].compressed),
  redeem: f.contract.redeem, signer: f[branch === "CLAIM" ? "claim" : "refund"],
  branch, lockHeight: 1359, ...(branch === "CLAIM" ? { preimage: f.secret } : {})
});

test("ephemeral claim/refund keys are distinct and compressed", () => {
  const f=fixture(); assert.equal(f.claim.compressed.length,33);
  assert.equal(f.refund.compressed.length,33);
  assert.notDeepEqual(f.claim.compressed, f.refund.compressed);
});
test("HTLC matches the existing legacy D2 branch template and P2SH output", () => {
  const f=fixture(),r=f.contract.redeem;
  assert.equal(r.subarray(0,6).toString("hex"),"6382012088a8");
  assert.deepEqual(r.subarray(7,39),sha256(f.secret));
  assert.deepEqual(f.contract.output,Buffer.concat([Buffer.from("a914","hex"),hash160(r),Buffer.from("87","hex")]));
  assert.ok(r.length <= 520);
});
test("claim is fully serialized, signed and self-verified", () => {
  const f=fixture(),tx=signedP2shSpend(terms(f)), raw=Buffer.from(tx.hex,"hex");
  assert.equal(raw.readUInt32LE(0),1);
  assert.equal(tx.txid,hash256(raw).reverse().toString("hex"));
  assert.equal(tx.outputKoinu,"490000000");
  assert.equal(Buffer.from(tx.derSignatureHex,"hex")[0],0x30);
  assert.equal(verify("sha256",sha256(Buffer.from("deadbeef","hex")),f.claim.publicKey,Buffer.from(tx.derSignatureHex,"hex")),false);
});
test("refund binds CLTV and does not expose claim preimage", () => {
  const f=fixture(),a=signedP2shSpend(terms(f)),b=signedP2shSpend(terms(f,"REFUND")),raw=Buffer.from(b.hex,"hex");
  assert.equal(raw.readUInt32LE(raw.length-4),1359);
  assert.notEqual(a.txid,b.txid);
  assert.ok(b.inputScriptHex.endsWith(scriptPush(f.contract.redeem).toString("hex")));
  assert.equal(b.inputScriptHex.includes(f.secret.toString("hex")),false);
});
test("P2SH redeem uses PUSHDATA1 and integer koinu output", () => {
  const f=fixture(),tx=signedP2shSpend(terms(f));
  assert.equal(scriptPush(f.contract.redeem)[0],0x4c);
  assert.ok(Buffer.from(tx.hex,"hex").includes(Buffer.from("80ce341d00000000","hex")));
});
test("rejects malformed outpoints and unsigned amount/fee inputs", () => {
  const f=fixture(),p=terms(f);
  for(const txid of ["zz".repeat(32),"ab".repeat(31),"AB".repeat(32)]) assert.throws(()=>signedP2shSpend({...p,prevTxid:txid}));
  for(const vout of [-1,2**32,1.2]) assert.throws(()=>signedP2shSpend({...p,vout}));
  for(const fee of [0n,500000000n,-1n,1]) assert.throws(()=>signedP2shSpend({...p,feeKoinu:fee}));
});
test("rejects unknown branch and invalid preimage rules", () => {
  const f=fixture(),p=terms(f);
  assert.throws(()=>signedP2shSpend({...p,branch:"UNKNOWN"}));
  assert.throws(()=>signedP2shSpend({...p,preimage:Buffer.alloc(31)}));
  assert.throws(()=>signedP2shSpend({...terms(f,"REFUND"),preimage:f.secret}));
});
test("rejects reused claim/refund signer and invalid lock domains", () => {
  const signer=temporarySigner(),commitment=sha256(Buffer.alloc(32));
  assert.throws(()=>makeHtlc({preimageHash:commitment,claimPublic:signer.compressed,refundPublic:signer.compressed,lockHeight:1352}));
  for(const height of [0,-1,500000000,1.5]) assert.throws(()=>makeHtlc({preimageHash:commitment,claimPublic:signer.compressed,refundPublic:temporarySigner().compressed,lockHeight:height}));
});
test("enforces exact scriptPush bounds", () => {
  assert.equal(scriptPush(Buffer.alloc(75))[0],75);
  assert.equal(scriptPush(Buffer.alloc(76)).subarray(0,2).toString("hex"),"4c4c");
  assert.equal(scriptPush(Buffer.alloc(520)).subarray(0,3).toString("hex"),"4d0802");
  assert.throws(()=>scriptPush(Buffer.alloc(521)));
});
test("legacy sighash binds destination and outpoint independently", () => {
  const f=fixture(),p=terms(f),a=signedP2shSpend(p);
  assert.notEqual(a.sighashHex,signedP2shSpend({...p,destinationScript:p2pkhOutput(temporarySigner().compressed)}).sighashHex);
  assert.notEqual(a.sighashHex,signedP2shSpend({...p,prevTxid:"ac".repeat(32)}).sighashHex);
});
test("Dogecoin regtest address prefixes are network-specific", () => {
  const f=fixture();assert.match(miningRegtestAddress(f.claim.compressed),/^[mn]/);
  assert.match(p2shRegtestAddress(f.contract.redeem),/^2/);
});
test("mature coinbase funding makes two separate contracts plus change", () => {
  const miner=temporarySigner(),a=fixture(),b=fixture();
  const funded=signedCoinbaseFunding({prevTxid:"ef".repeat(32),vout:2,coinbaseKoinu:1000000000000n,
    signer:miner,claimScript:a.contract.output,refundScript:b.contract.output});
  assert.equal(funded.contractKoinu,"500000000");
  assert.equal(funded.changeKoinu,"998990000000");
  const raw=Buffer.from(funded.hex,"hex");assert.equal(funded.txid,hash256(raw).reverse().toString("hex"));
  assert.ok(raw.includes(a.contract.output));assert.ok(raw.includes(b.contract.output));
  assert.ok(raw.includes(p2pkhOutput(miner.compressed)));
});
test("funding rejects duplicated outputs and immature/insufficient amounts", () => {
  const miner=temporarySigner(),a=fixture(),b=fixture();
  const p={prevTxid:"ef".repeat(32),vout:2,coinbaseKoinu:1000000000000n,signer:miner,
    claimScript:a.contract.output,refundScript:b.contract.output};
  assert.throws(()=>signedCoinbaseFunding({...p,refundScript:a.contract.output}));
  assert.throws(()=>signedCoinbaseFunding({...p,coinbaseKoinu:400000000n}));
});
