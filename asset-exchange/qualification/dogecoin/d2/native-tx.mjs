/**
 * Dogecoin 1.14.9 legacy-P2SH transaction builder for isolated synthetic regtest ONLY.
 * This is not an atomic swap protocol, a wallet or a financial qualification.
 * Private keys are created and held only in memory by the opt-in native runner.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const UINT32 = 0xffffffff;
const MAX_MONEY_KOINU = 10_000_000_000n * 100_000_000n;
const h = (algo, value) => createHash(algo).update(value).digest();
export const sha256 = (value) => h("sha256", value);
export const hash256 = (value) => sha256(sha256(value));
export const hash160 = (value) => h("ripemd160", sha256(value));

function assertBuffer(value, name, min, max = min) {
  if (!Buffer.isBuffer(value) || value.length < min || value.length > max) throw new Error(`${name}: invalid byte length`);
}
function u32(number) {
  if (!Number.isSafeInteger(number) || number < 0 || number > UINT32) throw new Error("invalid uint32");
  const b = Buffer.alloc(4); b.writeUInt32LE(number); return b;
}
function u64(value) {
  if (typeof value !== "bigint" || value < 0n || value > MAX_MONEY_KOINU) throw new Error("invalid koinu value");
  const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b;
}
function compactSize(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 65535) throw new Error("oversized compact size");
  if (n < 253) return Buffer.from([n]);
  const b = Buffer.alloc(3); b[0] = 253; b.writeUInt16LE(n, 1); return b;
}
export function scriptPush(value) {
  assertBuffer(value, "push", 0, 520);
  if (value.length < 76) return Buffer.concat([Buffer.from([value.length]), value]);
  if (value.length <= 255) return Buffer.concat([Buffer.from([0x4c, value.length]), value]);
  const prefix = Buffer.alloc(3); prefix[0] = 0x4d; prefix.writeUInt16LE(value.length, 1);
  return Buffer.concat([prefix, value]);
}
function scriptNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 500_000_000) throw new Error("height-only CLTV required");
  if (value <= 16) return Buffer.from([0x50 + value]);
  const bytes = [];
  let v = value;
  while (v) { bytes.push(v & 255); v = Math.floor(v / 256); }
  if (bytes.at(-1) & 0x80) bytes.push(0);
  return scriptPush(Buffer.from(bytes));
}
function requirePub(value) { assertBuffer(value, "secp256k1 compressed public key", 33); if (value[0] !== 2 && value[0] !== 3) throw new Error("uncompressed or invalid public key"); }
export function temporarySigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  assertBuffer(x, "public x", 32);
  assertBuffer(y, "public y", 32);
  return { privateKey, publicKey, compressed: Buffer.concat([Buffer.from([2 + (y[31] & 1)]), x]) };
}
export function makeHtlc({ preimageHash, claimPublic, refundPublic, lockHeight }) {
  assertBuffer(preimageHash, "commitment", 32);
  requirePub(claimPublic); requirePub(refundPublic);
  if (claimPublic.equals(refundPublic)) throw new Error("claim/refund keys must differ");
  const redeem = Buffer.concat([
    Buffer.from([0x63, 0x82, 0x01, 0x20, 0x88, 0xa8]), scriptPush(preimageHash), Buffer.from([0x88]),
    scriptPush(claimPublic), Buffer.from([0xac, 0x67]), scriptNumber(lockHeight), Buffer.from([0xb1, 0x75]),
    scriptPush(refundPublic), Buffer.from([0xac, 0x68])
  ]);
  if (redeem.length > 520) throw new Error("P2SH redeemScript too large");
  const output = Buffer.concat([Buffer.from([0xa9, 0x14]), hash160(redeem), Buffer.from([0x87])]);
  return { redeem, output, lockHeight, redeemSha256: sha256(redeem).toString("hex") };
}
export function p2pkhOutput(compressed) {
  requirePub(compressed);
  return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash160(compressed), Buffer.from([0x88, 0xac])]);
}

function serialize({ prevTxid, vout, inputScript, sequence, value, destinationScript, lockTime }) {
  if (typeof prevTxid !== "string" || !/^[0-9a-f]{64}$/.test(prevTxid)) throw new Error("invalid prevTxid");
  assertBuffer(inputScript, "scriptSig", 0, 10_000);
  assertBuffer(destinationScript, "destination", 1, 100);
  return Buffer.concat([
    u32(1), Buffer.from([1]), Buffer.from(prevTxid, "hex").reverse(), u32(vout),
    compactSize(inputScript.length), inputScript, u32(sequence), Buffer.from([1]),
    u64(value), compactSize(destinationScript.length), destinationScript, u32(lockTime)
  ]);
}
function parseDer(signature) {
  assertBuffer(signature, "DER", 8, 73);
  if (signature[0] !== 0x30 || signature[1] !== signature.length - 2 || signature[2] !== 2) throw new Error("malformed DER signature");
  const rlen = signature[3], rpos = 4;
  const spos = rpos + rlen;
  if (!rlen || signature[spos] !== 2 || spos + 2 > signature.length) throw new Error("malformed DER r");
  const slen = signature[spos + 1];
  if (!slen || spos + 2 + slen !== signature.length) throw new Error("malformed DER s");
  const r = BigInt(`0x${signature.subarray(rpos, spos).toString("hex")}`);
  const s = BigInt(`0x${signature.subarray(spos + 2).toString("hex")}`);
  if (r < 1n || r >= N || s < 1n || s >= N) throw new Error("invalid DER scalar");
  return { r, s };
}
function derInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  while (hex.length > 2 && hex.startsWith("00") && (parseInt(hex.slice(2, 4), 16) & 0x80) === 0) hex = hex.slice(2);
  if ((parseInt(hex.slice(0, 2), 16) & 0x80) !== 0) hex = `00${hex}`;
  const bytes = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
}
function lowSDer(input) {
  const { r, s } = parseDer(input);
  const a = derInteger(r), b = derInteger(s > N / 2n ? N - s : s);
  return Buffer.concat([Buffer.from([0x30, a.length + b.length]), a, b]);
}
export function signedP2shSpend({ prevTxid, vout, inputKoinu, feeKoinu, destinationScript,
  redeem, signer, branch, preimage, lockHeight }) {
  if (!signer?.privateKey || !signer?.publicKey || !Buffer.isBuffer(signer?.compressed)) throw new Error("in-memory EC signer required");
  requirePub(signer.compressed);
  assertBuffer(redeem, "redeem", 1, 520);
  if (branch !== "CLAIM" && branch !== "REFUND") throw new Error("unknown HTLC branch");
  if (typeof inputKoinu !== "bigint" || typeof feeKoinu !== "bigint" || feeKoinu < 1n || feeKoinu >= inputKoinu) throw new Error("invalid bounded fee");
  const outputKoinu = inputKoinu - feeKoinu;
  const lockTime = branch === "CLAIM" ? 0 : lockHeight;
  if (branch === "CLAIM") assertBuffer(preimage, "32-byte claim preimage", 32);
  else if (preimage !== undefined) throw new Error("refund must not include a preimage");
  const unsignedFields = { prevTxid, vout, sequence: 0xfffffffe, value: outputKoinu, destinationScript, lockTime };
  const sighashPreimage = Buffer.concat([serialize({ ...unsignedFields, inputScript: redeem }), u32(1)]);
  const firstHash = sha256(sighashPreimage); // Node ECDSA with sha256 hashes once more: Bitcoin HASH256.
  const signature = lowSDer(sign("sha256", firstHash, signer.privateKey));
  if (!verify("sha256", firstHash, signer.publicKey, signature)) throw new Error("local ECDSA self-verification failed");
  const signedSig = Buffer.concat([signature, Buffer.from([1])]); // legacy SIGHASH_ALL
  const inputScript = branch === "CLAIM"
    ? Buffer.concat([scriptPush(signedSig), scriptPush(preimage), Buffer.from([0x51]), scriptPush(redeem)])
    : Buffer.concat([scriptPush(signedSig), Buffer.from([0]), scriptPush(redeem)]);
  const raw = serialize({ ...unsignedFields, inputScript });
  const txid = hash256(raw).reverse().toString("hex");
  return Object.freeze({ hex: raw.toString("hex"), txid, bytes: raw.length, inputScriptHex: inputScript.toString("hex"),
    outputKoinu: outputKoinu.toString(), sighashHex: hash256(sighashPreimage).toString("hex"),
    derSignatureHex: signature.toString("hex"), signatureLowS: true, branch });
}
// Dogecoin regtest uses Bitcoin-compatible test address version 111 (P2PKH)
// and P2SH version 196; verify both against native validateaddress/decodescript.
export function base58check(version, payload) {
  if (version !== 111 && version !== 196) throw new Error("regtest address version required");
  assertBuffer(payload, "address payload", 20);
  const data = Buffer.concat([Buffer.from([version]), payload]);
  const complete = Buffer.concat([data, hash256(data).subarray(0, 4)]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${complete.toString("hex")}`);
  let result = "";
  while (number > 0n) { result = alphabet[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of complete) { if (byte === 0) result = `1${result}`; else break; }
  return result;
}
export const miningRegtestAddress = (pub) => { requirePub(pub); return base58check(111, hash160(pub)); };
export const p2shRegtestAddress = (redeem) => { assertBuffer(redeem, "redeem", 1, 520); return base58check(196, hash160(redeem)); };

// P2PKH funding uses matured private-regtest coinbase output only, no wallet.
// Output values are exact integer koinu. A nonzero positive change is mandatory.
function serializeFunding({ prevTxid, vout, inputScript, outputs }) {
  if (typeof prevTxid !== "string" || !/^[0-9a-f]{64}$/.test(prevTxid)) throw new Error("invalid coinbase prevout");
  assertBuffer(inputScript, "funding scriptSig", 0, 520);
  if (!Array.isArray(outputs) || outputs.length !== 3) throw new Error("exact two contracts and change outputs required");
  return Buffer.concat([u32(1), Buffer.from([1]), Buffer.from(prevTxid, "hex").reverse(), u32(vout),
    compactSize(inputScript.length), inputScript, u32(0xfffffffe), compactSize(outputs.length),
    ...outputs.flatMap(o => {
      assertBuffer(o.scriptPubKey, "funding output", 1, 100);
      return [u64(o.valueKoinu), compactSize(o.scriptPubKey.length), o.scriptPubKey];
    }), u32(0)]);
}
export function signedCoinbaseFunding({ prevTxid, vout, coinbaseKoinu, signer, claimScript, refundScript,
  contractKoinu = 500_000_000n, feeKoinu = 10_000_000n }) {
  if (!signer?.privateKey || !signer?.publicKey) throw new Error("external test signer required");
  requirePub(signer.compressed);
  assertBuffer(claimScript, "claim funding output", 23);
  assertBuffer(refundScript, "refund funding output", 23);
  if (claimScript.length !== 23 || refundScript.length !== 23 || claimScript.equals(refundScript)) throw new Error("two distinct P2SH contract outputs required");
  const changeKoinu = coinbaseKoinu - 2n * contractKoinu - feeKoinu;
  if (typeof changeKoinu !== "bigint" || changeKoinu < 100_000_000n) throw new Error("sufficient mature coinbase funds and change required");
  const outputs = [
    { valueKoinu: contractKoinu, scriptPubKey: claimScript },
    { valueKoinu: contractKoinu, scriptPubKey: refundScript },
    { valueKoinu: changeKoinu, scriptPubKey: p2pkhOutput(signer.compressed) }
  ];
  const sighashPreimage = Buffer.concat([serializeFunding({ prevTxid, vout, inputScript: p2pkhOutput(signer.compressed), outputs }), u32(1)]);
  const firstHash = sha256(sighashPreimage);
  const signature = lowSDer(sign("sha256", firstHash, signer.privateKey));
  if (!verify("sha256", firstHash, signer.publicKey, signature)) throw new Error("funding ECDSA verification failed");
  const scriptSig = Buffer.concat([scriptPush(Buffer.concat([signature, Buffer.from([1])])), scriptPush(signer.compressed)]);
  const raw = serializeFunding({ prevTxid, vout, inputScript: scriptSig, outputs });
  return Object.freeze({ hex: raw.toString("hex"), txid: hash256(raw).reverse().toString("hex"),
    bytes: raw.length, feeKoinu: feeKoinu.toString(), contractKoinu: contractKoinu.toString(),
    changeKoinu: changeKoinu.toString(), scriptSigHex: scriptSig.toString("hex") });
}

export function syntheticHtlcBundle(lockHeight) {
  const claim = temporarySigner(), refund = temporarySigner();
  const secret = randomBytes(32);
  const contract = makeHtlc({ preimageHash: sha256(secret), claimPublic: claim.compressed, refundPublic: refund.compressed, lockHeight });
  return { claim, refund, secret, contract };
}
