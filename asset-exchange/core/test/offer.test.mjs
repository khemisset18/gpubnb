import test from "node:test";
import assert from "node:assert/strict";
import { createUnsignedOffer, offerDigestHex } from "../src/index.mjs";
const input={offerId:"offer-00000001",maker:"maker:test:001",giveAsset:{chainId:"bitcoin",networkId:"regtest",assetType:"NATIVE",assetId:"BTC_NATIVE",decimals:8},giveAmountAtomic:"100000000",wantAsset:{chainId:"litecoin",networkId:"regtest",assetType:"NATIVE",assetId:"LTC_NATIVE",decimals:8},wantAmountAtomic:"2500000000",expiryUnixMs:2000000000000,nonce:"ABCDEFGHIJKLMNOP",policyEpoch:7,feePolicy:{policyId:"default-taker-v1",version:1,rateBps:35,payerRole:"TAKER",feeAssetKey:"bitcoin|regtest|NATIVE|BTC_NATIVE|8",recipient:"treasury:test"}};
test("offer digest is deterministic",()=>{const a=createUnsignedOffer(input);const b=createUnsignedOffer({...input});assert.equal(offerDigestHex(a),offerDigestHex(b));assert.match(offerDigestHex(a),/^[0-9a-f]{64}$/);});
test("unknown offer fields fail closed",()=>assert.throws(()=>createUnsignedOffer({...input,surprise:true})));
test("asset/network ambiguity changes digest",()=>{const a=createUnsignedOffer(input);const b=createUnsignedOffer({...input,giveAsset:{...input.giveAsset,networkId:"testnet"}});assert.notEqual(offerDigestHex(a),offerDigestHex(b));});
