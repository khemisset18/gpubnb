// Integration worker. prl_disposable.py supplies an owned initdb and an optional
// external node-postgres installation. It never accepts a connection URL.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOfferService } from "../../api/src/offer-service.mjs";
import { createPostgresOfferRepository } from "../../api/src/postgres-offer-repository.mjs";
import { acceptanceDigestHex, createAcceptance, createUnsignedOffer, offerDigestHex } from "../../core/src/index.mjs";

const [driverPath, phase, ownedRoot, expectedSystemId] = process.argv.slice(2);
assert.match(expectedSystemId ?? "", /^\d+$/);
const env = process.env;
assert.equal(env.PGHOST, "127.0.0.1");
assert.equal(env.PGUSER, "prl_lab_owner");
assert.match(env.PGDATABASE, /^prl_scratch_[0-9a-f]{16}$/);
const data = join(ownedRoot, "data");
for (const directory of [ownedRoot, data]) {
  const info = lstatSync(directory);
  assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700);
}
const pid = readFileSync(join(data, "postmaster.pid"), "utf8").split("\n");
assert.equal(pid[1], data);
assert.equal(pid[3], env.PGPORT);
assert.equal(pid[7].trim(), "ready");

const { default: driver } = await import(pathToFileURL(driverPath));
const pool = new driver.Pool({host: "127.0.0.1", port: Number(env.PGPORT), user: env.PGUSER,
  password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, max: 4, connectionTimeoutMillis: 3000});
const deploymentId = "ae-test-01";
const maker = {subject: "maker:prl:lab", sessionId: "prl-lab-maker", authnMethod: "EXCHANGE_SESSION"};
const taker = {subject: "taker:prl:lab", sessionId: "prl-lab-taker", authnMethod: "EXCHANGE_SESSION"};
const receiptFile = join(ownedRoot, "public-api-receipt.json");

function service(verifier) {
  return createOfferService({repository: createPostgresOfferRepository({pool, deploymentId}), deploymentId,
    verifyOfferSignature: verifier, verifyAcceptanceSignature: verifier, verifyCancellationSignature: verifier});
}

function acceptance(offerId, offerHash, tradeId) {
  const now = Date.now();
  return {offerId, tradeId, offerHash, taker: taker.subject, deploymentId,
    policyEpoch: 7, acceptedAtUnixMs: now, expiryUnixMs: now + 60_000, nonce: randomUUID().replaceAll("-", "")};
}

function verifierFor(keys) {
  return ({actor, digestHex, signature}) => verify(null, Buffer.from(digestHex, "hex"),
    keys.get(actor.subject), Buffer.from(signature, "base64"));
}

function signDigest(privateKey, digest) {
  return sign(null, Buffer.from(digest, "hex"), privateKey).toString("base64");
}

async function historical() {
  let calls = 0;
  const svc = service(() => { calls++; throw new Error("historical PRL reached a verifier"); });
  for (const id of ["prl-old-give-0001", "prl-old-want-0001", "prl-old-open-0001"]) {
    const stored = await createPostgresOfferRepository({pool, deploymentId}).getOfferById(id);
    assert.ok(stored);
    const req = acceptance(id, stored.offerHash, randomUUID());
    await assert.rejects(svc.acceptOffer({actor: taker, acceptance: req,
      signature: "synthetic-historical-proof", idempotencyKey: randomUUID()}), {code:"PRL_ACCEPT_UNQUALIFIED"});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM asset_exchange.trades WHERE trade_id=$1",
      [req.tradeId])).rows[0].n, 0);
  }
  assert.equal(calls, 0);
  console.log("PASS PostgreSQL-backed API denied 3 historical PRL acceptances before verification or mutation");
}

async function controls() {
  const makerPair = generateKeyPairSync("ed25519");
  const takerPair = generateKeyPairSync("ed25519");
  const svc = service(verifierFor(new Map([[maker.subject, makerPair.publicKey], [taker.subject, takerPair.publicKey]])));
  const asset = name => ({chainId: name, networkId: "regtest", assetType: "NATIVE", assetId: "LAB_NATIVE", decimals: 8});
  const offer = createUnsignedOffer({offerId: randomUUID(), deploymentId, maker: maker.subject,
    giveAsset: asset("lab-alpha"), giveAmountAtomic: "1000", wantAsset: asset("lab-beta"), wantAmountAtomic: "2500",
    expiryUnixMs: Date.now() + 600_000, nonce: randomUUID().replaceAll("-", ""), policyEpoch: 7,
    feePolicy: {policyId: "default-taker-v1", version: 1, rateBps: 35, payerRole: "TAKER",
      feeAssetKey: "bitcoin|regtest|NATIVE|BTC_NATIVE|8", recipient: "treasury:test"}});
  const hash = offerDigestHex(offer);
  const publication = await svc.publishOffer({actor: maker, offer, signature: signDigest(makerPair.privateKey, hash),
    idempotencyKey: randomUUID()});
  assert.deepEqual(publication, {status:"OPEN", offerId:offer.offerId});
  const req = acceptance(offer.offerId, hash, randomUUID());
  const digest = acceptanceDigestHex(createAcceptance(req));
  const good = {actor: taker, acceptance:req, signature: signDigest(takerPair.privateKey, digest), idempotencyKey:randomUUID()};
  await assert.rejects(svc.acceptOffer({...good, actor:maker}), {code:"OBJECT_AUTHZ"});
  await assert.rejects(svc.acceptOffer({...good, signature:signDigest(makerPair.privateKey,digest)}), {code:"ACCEPT_SIGNATURE_INVALID"});
  assert.equal((await pool.query("SELECT state FROM asset_exchange.offers WHERE offer_id=$1", [offer.offerId])).rows[0].state,"OPEN");
  const expected = {status:"CONSUMED", tradeId:req.tradeId};
  const outcomes = await Promise.all([svc.acceptOffer(good), svc.acceptOffer(good)]);
  assert.deepEqual(outcomes, [expected, expected]);
  const other = {...req, tradeId:randomUUID()};
  await assert.rejects(svc.acceptOffer({...good, acceptance:other,
    signature:signDigest(takerPair.privateKey, acceptanceDigestHex(createAcceptance(other)))}), {code:"23505"});
  writeFileSync(receiptFile, JSON.stringify({good, expected,
    publicKey:takerPair.publicKey.export({type:"spki",format:"pem"})}), {mode:0o600,flag:"wx"});
  console.log("PASS signed synthetic publication, actor binding, bad signature, concurrent identical accept and changed-key-payload refusal");
}

async function restarted() {
  const {good, expected, publicKey} = JSON.parse(readFileSync(receiptFile,"utf8"));
  const svc = service(verifierFor(new Map([[taker.subject,createPublicKey(publicKey)]])));
  assert.deepEqual(await svc.acceptOffer(good), expected);
  const state = await pool.query(`SELECT
    (SELECT count(*)::int FROM asset_exchange.trades WHERE offer_id=$1) AS trades,
    (SELECT count(*)::int FROM asset_exchange.trade_events WHERE trade_id=$2) AS events,
    (SELECT count(*)::int FROM asset_exchange.idempotency_records WHERE idempotency_key=$3) AS receipts`,
    [good.acceptance.offerId, good.acceptance.tradeId, good.idempotencyKey]);
  assert.deepEqual(state.rows[0], {trades:1,events:1,receipts:1});
  console.log("PASS new Node process with only a public signed request, one durable trade/event/idempotency record");
}

try {
  const identity = await pool.query(`SELECT current_database() AS db, current_user AS role,
    current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS host`);
  assert.deepEqual(identity.rows[0], {db:env.PGDATABASE,role:env.PGUSER,cluster:"prl_lab_" + expectedSystemId,host:"127.0.0.1"});
  if (phase === "historical") await historical();
  else if (phase === "controls") await controls();
  else if (phase === "restarted") await restarted();
  else throw new Error("unknown private lab phase");
} finally {
  await pool.end();
}
