import test from "node:test";
import assert from "node:assert/strict";
import { assertStoredOfferAssetPolicy, createOfferService } from "../../api/src/offer-service.mjs";

const BTC="bitcoin|regtest|NATIVE|BTC_NATIVE|8";
const LTC="litecoin|regtest|NATIVE|LTC_NATIVE|8";
const PRL="pearl|mainnet|NATIVE|PRL_NATIVE_UNVERIFIED|8";
const OFFER_HASH="a".repeat(64);
const actor={subject:"taker:test:prl",sessionId:"session-test-prl-001",authnMethod:"EXCHANGE_SESSION"};
const placeholder="NOT_A_SIGNATURE_PUBLIC_TEST_VALUE";

function stored(giveAssetKey=BTC,wantAssetKey=LTC) {
  return {offerId:"historic-offer-0001",makerSubject:"maker:test:prl",
    state:"OPEN",offerHash:OFFER_HASH,policyEpoch:7,giveAssetKey,wantAssetKey};
}
function acceptance() {
  return {offerId:"historic-offer-0001",tradeId:"historic-trade-0001",
    deploymentId:"ae-test-01",taker:actor.subject,offerHash:OFFER_HASH,
    acceptedAtUnixMs:1000,expiryUnixMs:2000,nonce:"ABCDEFGHIJKLMNOP",policyEpoch:7};
}
function harness(row) {
  const calls={get:0,verify:0,accept:0};
  const repository={
    async getOfferById(){calls.get++;return row;},
    async insertOfferAtomic(){throw Error("unexpected insert");},
    async cancelOfferAtomic(){throw Error("unexpected cancel");},
    async acceptOfferAtomic(){calls.accept++;throw Error("unexpected accept write");}
  };
  return {calls,service:createOfferService({
    repository,deploymentId:"ae-test-01",
    verifyOfferSignature:async()=>{throw Error("unexpected verifier");},
    verifyCancellationSignature:async()=>{throw Error("unexpected verifier");},
    verifyAcceptanceSignature:async()=>{calls.verify++;return false;},
    now:()=>1000
  })};
}
async function rejectBeforeVerifier(row,code="PRL_ACCEPT_UNQUALIFIED") {
  const {service,calls}=harness(row);
  await assert.rejects(()=>service.acceptOffer({
    actor,acceptance:acceptance(),signature:placeholder,
    idempotencyKey:"prl-historical-test-0001"
  }),err=>err?.code===code);
  assert.deepEqual(calls,{get:1,verify:0,accept:0});
}

test("stored PRL given asset blocked before verifier/database",async()=>{
  await rejectBeforeVerifier(stored(PRL,LTC));
});
test("stored PRL wanted asset blocked before verifier/database",async()=>{
  await rejectBeforeVerifier(stored(BTC,PRL));
});
test("regtest and simnet PRL also blocked",async()=>{
  await rejectBeforeVerifier(stored("pearl|regtest|NATIVE|PRL|8",LTC));
  await rejectBeforeVerifier(stored(BTC,"pearl|simnet|NATIVE|PRL|8"));
});
test("legacy uppercase, padded and ticker-alias PRL blocked",async()=>{
  for(const chain of ["PEARL","Pearl"," pearl ","PRL","prl"])
    await rejectBeforeVerifier(stored(chain+"|mainnet|NATIVE|PRL|8",LTC));
});
test("token and NFT disguises still blocked",()=>{
  for(const kind of ["NATIVE","TOKEN","NFT"])
    assert.throws(()=>assertStoredOfferAssetPolicy(
      stored("pearl|mainnet|"+kind+"|PRL|8",LTC)),
      err=>err?.code==="PRL_ACCEPT_UNQUALIFIED");
});
test("missing stored offer blocks before verifier",async()=>{
  await rejectBeforeVerifier(null,"OFFER_NOT_FOUND");
});
test("missing stored identity keys fail closed",async()=>{
  await rejectBeforeVerifier({...stored(),giveAssetKey:undefined},"ACCEPT_ASSET_KEY_MISSING");
  await rejectBeforeVerifier({...stored(),wantAssetKey:undefined},"ACCEPT_ASSET_KEY_MISSING");
});
test("malformed stored identities fail closed",async()=>{
  const bad=["","|regtest|NATIVE|BTC|8","bitcoin|regtest|NATIVE|BTC",
    "bitcoin|regtest|NATIVE|BTC|08","bitcoin|regtest|NATIVE|BTC|256",
    "BITCOIN|regtest|NATIVE|BTC|8","bitcoin|regtest|NATIVE|BTC|8|EXTRA",
    "bitcoin|regtest|NATIVE||8","bitcoin|regtest|NATIVE| BTC|8",
    "bitcoin|regtest|NATIVE|BTC |8","bitcoin|regtest|NATIVE|BTC|8".repeat(120)];
  for(const key of bad)
    await rejectBeforeVerifier(stored(key,LTC),
      key.length>512||key===""?"ACCEPT_ASSET_KEY_MISSING":"ACCEPT_ASSET_KEY_INVALID");
});
test("existing non PRL verifier still reached, but no signing or write",async()=>{
  const {service,calls}=harness(stored());
  await assert.rejects(()=>service.acceptOffer({
    actor,acceptance:acceptance(),signature:placeholder,
    idempotencyKey:"prl-historical-test-0002"
  }),err=>err?.code==="ACCEPT_SIGNATURE_INVALID");
  assert.deepEqual(calls,{get:1,verify:1,accept:0});
});
test("cancelled historical offer cannot be accepted",async()=>{
  await rejectBeforeVerifier({...stored(),state:"CANCELLED"},"OFFER_NOT_OPEN");
});
test("stored offer hash mismatch is refused",async()=>{
  await rejectBeforeVerifier({...stored(),offerHash:"b".repeat(64)},
    "ACCEPT_OFFER_HASH_MISMATCH");
});
test("stored policy epoch mismatch is refused",async()=>{
  await rejectBeforeVerifier({...stored(),policyEpoch:8},"ACCEPT_EPOCH_MISMATCH");
});
test("stored PRL rejection does not modify original public data",()=>{
  const row=stored(PRL,BTC),before=JSON.stringify(row);
  assert.throws(()=>assertStoredOfferAssetPolicy(row),
    err=>err?.code==="PRL_ACCEPT_UNQUALIFIED");
  assert.equal(JSON.stringify(row),before);
});
test("two non PRL canonical asset keys pass targeted policy",()=>{
  assert.doesNotThrow(()=>assertStoredOfferAssetPolicy(stored()));
});
