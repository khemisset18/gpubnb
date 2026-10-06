import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";
import { createActor, validateIdempotencyKey } from "./authz.mjs";
import {
  parseSignedBitcoinSettlementTerms,
  bitcoinSettlementTermsDigestHex
} from "../../settlement/src/bitcoin-settlement-terms.mjs";

function opaqueSignature(signature) {
  const bytes = Buffer.isBuffer(signature)
    ? signature
    : typeof signature === "string"
      ? Buffer.from(signature, "utf8")
      : null;
  invariant(bytes !== null, "TERMS_SIGNATURE_TYPE", "signature must be opaque bytes or string");
  invariant(bytes.length >= 1 && bytes.length <= 8192, "TERMS_SIGNATURE_LENGTH", "invalid signature length");
  return signature;
}

export function createBitcoinTermsService({
  repository,
  verifyTermsSignature,
  deploymentId
}) {
  invariant(repository && typeof repository.getTradeById === "function", "TERMS_REPOSITORY", "terms repository required");
  invariant(typeof repository.submitTermsSignatureAtomic === "function", "TERMS_REPOSITORY", "terms repository submit required");
  invariant(typeof verifyTermsSignature === "function", "TERMS_SIGNATURE_VERIFIER", "terms signature verifier required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);

  return Object.freeze({
    async submitSignature({ actor, terms, signature, idempotencyKey }) {
      const parsedActor = createActor(actor);
      validateIdempotencyKey(idempotencyKey);
      opaqueSignature(signature);

      const parsedTerms = parseSignedBitcoinSettlementTerms(terms);
      invariant(parsedTerms.deploymentId === scopedDeploymentId, "DEPLOYMENT_MISMATCH", "settlement terms deployment mismatch");

      const trade = await repository.getTradeById(parsedTerms.tradeId);
      invariant(trade !== null, "TRADE_NOT_FOUND", "trade not found");
      invariant(trade.deploymentId === scopedDeploymentId, "DEPLOYMENT_MISMATCH", "trade deployment mismatch");
      invariant(["ACCEPTED_PENDING_TERMS","TERMS_SIGNED"].includes(trade.state), "TERMS_STATE", "trade does not accept terms signatures");

      invariant(parsedTerms.offerHash === trade.offerHash, "TERMS_OFFER_HASH_MISMATCH", "terms offer hash mismatch");
      invariant(parsedTerms.makerSubject === trade.makerSubject, "TERMS_MAKER_MISMATCH", "terms maker mismatch");
      invariant(parsedTerms.takerSubject === trade.takerSubject, "TERMS_TAKER_MISMATCH", "terms taker mismatch");
      invariant(parsedTerms.policyEpoch === trade.policyEpoch, "TERMS_EPOCH_MISMATCH", "terms policy epoch mismatch");
      invariant(parsedTerms.feePolicyId === trade.feePolicyId, "TERMS_FEE_POLICY_MISMATCH", "terms fee policy id mismatch");
      invariant(parsedTerms.feePolicyVersion === trade.feePolicyVersion, "TERMS_FEE_POLICY_MISMATCH", "terms fee policy version mismatch");

      let role;
      if (parsedActor.subject === trade.makerSubject) role = "MAKER";
      else if (parsedActor.subject === trade.takerSubject) role = "TAKER";
      else invariant(false, "OBJECT_AUTHZ", "actor is not a party to this trade");

      const digestHex = bitcoinSettlementTermsDigestHex(parsedTerms);
      if (trade.termsHash !== null) {
        invariant(trade.termsHash === digestHex, "TERMS_HASH_MISMATCH", "trade already bound to different settlement terms");
      }

      const verified = await verifyTermsSignature({
        actor: parsedActor,
        role,
        terms: parsedTerms,
        digestHex,
        signature
      });
      invariant(verified === true, "TERMS_SIGNATURE_INVALID", "settlement terms signature verification failed");

      return repository.submitTermsSignatureAtomic({
        actorSubject: parsedActor.subject,
        role,
        tradeId: parsedTerms.tradeId,
        termsHash: digestHex,
        signature,
        idempotencyKey
      });
    }
  });
}
