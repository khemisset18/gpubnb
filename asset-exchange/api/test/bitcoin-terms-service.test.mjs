import test from "node:test";
import assert from "node:assert/strict";
import { createBitcoinTermsService } from "../src/bitcoin-terms-service.mjs";
import { buildBitcoinHtlcV1 } from "../../settlement/src/bitcoin-htlc-v1.mjs";
import { deriveBitcoinRefundTimeoutV1 } from "../../settlement/src/bitcoin-timeout-policy.mjs";
import { bitcoinSettlementTermsDigestHex, createBitcoinSettlementTerms } from "../../settlement/src/bitcoin-settlement-terms.mjs";

const maker = { subject: "maker:test:001", sessionId: "session-maker-001", authnMethod: "EXCHANGE_SESSION" };
const taker = { subject: "taker:test:001", sessionId: "session-taker-001", authnMethod: "EXCHANGE_SESSION" };

const confirmationPolicy = {
  policyId: "btc-regtest-confirm-v1",
  network: "regtest",
  amountBands: [
    { maxAmountSats: "500000", confirmations: 2 },
    { maxAmountSats: null, confirmations: 6 }
  ],
  riskFloors: { LOW: 1, STANDARD: 2, HIGH: 3, EXTREME: 6 }
};

const timeoutPolicy = {
  policyId: "btc-regtest-risk-v1",
  network: "regtest",
  maxFundingBroadcastDelayBlocks: 2,
  fundingConfirmations: 2,
  counterpartyActionBudgetBlocks: 3,
  watcherUncertaintyBudgetBlocks: 1,
  reorgSafetyBlocks: 6,
  feeBumpBudgetBlocks: 2,
  recoveryExecutionBlocks: 2,
  operatorFallbackBlocks: 4,
  additionalSafetyBlocks: 2
};
const timeout = deriveBitcoinRefundTimeoutV1({ anchorHeight: 400, policy: timeoutPolicy });
const redeem = "03c150061989643d77162902b725409087959f15914649d4f06b6cc3f8c87bb238";
const refund = "020461e6025e68bdc5a1d6730b2fb13c4c62d295f226f0c3dbd0b713530897a6b4";
const secretHash = "33".repeat(32);
const built = buildBitcoinHtlcV1({
  secretHashHex: secretHash,
  redeemPubkeyHex: redeem,
  refundPubkeyHex: refund,
  refundLockHeight: timeout.refundLockHeight
});

const termsInput = {
  deploymentId: "ae-test-01",
  tradeId: "trade-00000001",
  offerHash: "aa".repeat(32),
  makerSubject: maker.subject,
  takerSubject: taker.subject,
  policyEpoch: 7,
  network: "regtest",
  protocolId: "GPUBNB-ASSET-EXCHANGE-BTC-P2WSH-HTLC-V1",
  protocolVersion: 1,
  fundingAmountSats: "100000",
  secretHashHex: secretHash,
  redeemPubkeyHex: redeem,
  refundPubkeyHex: refund,
  timeoutPolicy,
  timeoutAnchorHeight: 400,
  confirmationPolicy,
  confirmationRiskClass: "STANDARD",
  refundLockHeight: timeout.refundLockHeight,
  witnessScriptHashHex: built.witnessScriptHashHex,
  scriptPubKeyHex: built.scriptPubKeyHex,
  requiredConfirmations: 2,
  sighashType: 1,
  feePolicyId: "owner-fee-v1",
  feePolicyVersion: 1
};
const normalizedTerms = createBitcoinSettlementTerms(termsInput);
const termsHash = bitcoinSettlementTermsDigestHex(normalizedTerms);

function fakeRepository() {
  const calls = [];
  let trade = {
    tradeId: termsInput.tradeId,
    deploymentId: termsInput.deploymentId,
    offerHash: termsInput.offerHash,
    makerSubject: maker.subject,
    takerSubject: taker.subject,
    policyEpoch: 7,
    feePolicyId: "owner-fee-v1",
    feePolicyVersion: 1,
    state: "ACCEPTED_PENDING_TERMS",
    termsHash: null,
    makerSigned: false,
    takerSigned: false
  };

  return {
    calls,
    async getTradeById() { return { ...trade }; },
    async submitTermsSignatureAtomic(input) {
      calls.push(input);
      if (trade.termsHash === null) trade.termsHash = input.termsHash;
      if (input.role === "MAKER") trade.makerSigned = true;
      if (input.role === "TAKER") trade.takerSigned = true;
      if (trade.makerSigned && trade.takerSigned) trade.state = "TERMS_SIGNED";
      return { status: trade.state, tradeId: trade.tradeId };
    }
  };
}

function service(repository, overrides = {}) {
  return createBitcoinTermsService({
    repository,
    verifyTermsSignature: async () => true,
    deploymentId: "ae-test-01",
    ...overrides
  });
}

test("maker and taker must sign the same final terms before TERMS_SIGNED", async () => {
  const repo = fakeRepository();
  const svc = service(repo);

  const makerResult = await svc.submitSignature({
    actor: maker,
    terms: normalizedTerms,
    signature: "maker-sig",
    idempotencyKey: "terms-maker-key-0001"
  });
  assert.equal(makerResult.status, "ACCEPTED_PENDING_TERMS");

  const takerResult = await svc.submitSignature({
    actor: taker,
    terms: normalizedTerms,
    signature: "taker-sig",
    idempotencyKey: "terms-taker-key-0001"
  });
  assert.equal(takerResult.status, "TERMS_SIGNED");
  assert.equal(repo.calls[0].termsHash, termsHash);
  assert.equal(repo.calls[1].termsHash, termsHash);
});

test("wrong party, invalid signature, or lineage mismatch cannot persist terms", async () => {
  const repo = fakeRepository();
  const svc = service(repo);

  await assert.rejects(() => svc.submitSignature({
    actor: { ...maker, subject: "other:test:001" },
    terms: normalizedTerms,
    signature: "sig",
    idempotencyKey: "terms-other-key-0001"
  }));

  const rejecting = service(repo, { verifyTermsSignature: async () => false });
  await assert.rejects(() => rejecting.submitSignature({
    actor: maker,
    terms: normalizedTerms,
    signature: "sig",
    idempotencyKey: "terms-badsig-key-001"
  }));

  await assert.rejects(() => svc.submitSignature({
    actor: maker,
    terms: { ...termsInput, offerHash: "bb".repeat(32) },
    signature: "sig",
    idempotencyKey: "terms-badline-key-01"
  }));

  assert.equal(repo.calls.length, 0);
});
