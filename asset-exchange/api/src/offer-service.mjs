import { createUnsignedOffer, offerDigestHex } from "../../core/src/offer.mjs";
import { createAcceptance, acceptanceDigestHex } from "../../core/src/acceptance.mjs";
import { createCancellation, cancellationDigestHex } from "../../core/src/cancellation.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";
import { assertSameSubject, createActor, validateIdempotencyKey } from "./authz.mjs";

function opaqueSignature(signature) {
  const isBuffer = Buffer.isBuffer(signature);
  const isString = typeof signature === "string";
  invariant(isBuffer || isString, "SIGNATURE_TYPE", "signature must be opaque bytes or string");
  const length = isBuffer ? signature.byteLength : Buffer.byteLength(signature, "utf8");
  invariant(length >= 1 && length <= 8192, "SIGNATURE_LENGTH", "signature length invalid");
  return signature;
}

export function createOfferService({
  repository,
  verifyOfferSignature,
  verifyAcceptanceSignature,
  verifyCancellationSignature,
  deploymentId,
  maxClockSkewMs = 120_000,
  now = () => Date.now()
}) {
  invariant(repository && typeof repository === "object", "OFFER_REPOSITORY", "repository required");
  for (const method of ["insertOfferAtomic", "getOfferById", "cancelOfferAtomic", "acceptOfferAtomic"]) {
    invariant(typeof repository[method] === "function", "OFFER_REPOSITORY_METHOD", `repository.${method} required`);
  }
  invariant(typeof verifyOfferSignature === "function", "OFFER_SIGNATURE_VERIFIER", "offer signature verifier required");
  invariant(typeof verifyAcceptanceSignature === "function", "ACCEPT_SIGNATURE_VERIFIER", "acceptance signature verifier required");
  invariant(typeof verifyCancellationSignature === "function", "CANCEL_SIGNATURE_VERIFIER", "cancellation signature verifier required");
  invariant(typeof now === "function", "CLOCK", "authoritative clock required");
  const serviceDeploymentId = validateDeploymentId(deploymentId);
  invariant(Number.isSafeInteger(maxClockSkewMs) && maxClockSkewMs >= 0 && maxClockSkewMs <= 300_000, "CLOCK_SKEW", "invalid max clock skew");

  return Object.freeze({
    async publishOffer({ actor, offer, signature, idempotencyKey }) {
      const parsedActor = createActor(actor);
      const parsedOffer = createUnsignedOffer(offer);
      assertSameSubject(parsedActor, parsedOffer.maker);
      invariant(parsedOffer.deploymentId === serviceDeploymentId, "DEPLOYMENT_MISMATCH", "offer belongs to another deployment");
      validateIdempotencyKey(idempotencyKey);
      opaqueSignature(signature);

      const currentTime = now();
      invariant(Number.isSafeInteger(currentTime), "CLOCK_VALUE", "clock must return integer milliseconds");
      invariant(currentTime < parsedOffer.expiryUnixMs, "OFFER_EXPIRED", "cannot publish expired offer");

      const verified = await verifyOfferSignature({
        actor: parsedActor,
        offer: parsedOffer,
        digestHex: offerDigestHex(parsedOffer),
        signature
      });
      invariant(verified === true, "OFFER_SIGNATURE_INVALID", "offer signature verification failed");

      return repository.insertOfferAtomic({
        actorSubject: parsedActor.subject,
        offer: parsedOffer,
        offerHash: offerDigestHex(parsedOffer),
        signature,
        idempotencyKey
      });
    },

    async cancelOffer({ actor, cancellation, signature, idempotencyKey }) {
      const parsedActor = createActor(actor);
      const parsedCancellation = createCancellation(cancellation);
      validateIdempotencyKey(idempotencyKey);
      opaqueSignature(signature);

      assertSameSubject(parsedActor, parsedCancellation.maker);
      invariant(parsedCancellation.deploymentId === serviceDeploymentId, "DEPLOYMENT_MISMATCH", "cancellation belongs to another deployment");

      const stored = await repository.getOfferById(parsedCancellation.offerId);
      invariant(stored !== null && stored !== undefined, "OFFER_NOT_FOUND", "offer not found");
      assertSameSubject(parsedActor, stored.makerSubject);
      invariant(stored.state === "OPEN", "OFFER_NOT_OPEN", "offer is not open");
      invariant(stored.offerHash === parsedCancellation.offerHash, "CANCEL_OFFER_HASH_MISMATCH", "cancellation offer hash mismatch");
      invariant(stored.policyEpoch === parsedCancellation.policyEpoch, "CANCEL_EPOCH_MISMATCH", "cancellation policy epoch mismatch");

      const currentTime = now();
      invariant(Number.isSafeInteger(currentTime), "CLOCK_VALUE", "clock must return integer milliseconds");
      invariant(parsedCancellation.cancelledAtUnixMs <= currentTime + maxClockSkewMs, "CANCEL_FUTURE", "cancellation timestamp is too far in the future");
      invariant(currentTime < parsedCancellation.expiryUnixMs, "CANCEL_EXPIRED", "cancellation expired");

      const digestHex = cancellationDigestHex(parsedCancellation);
      const verified = await verifyCancellationSignature({
        actor: parsedActor,
        cancellation: parsedCancellation,
        digestHex,
        signature
      });
      invariant(verified === true, "CANCEL_SIGNATURE_INVALID", "cancellation signature verification failed");

      return repository.cancelOfferAtomic({
        cancellation: parsedCancellation,
        cancellationHash: digestHex,
        signature,
        makerSubject: parsedActor.subject,
        idempotencyKey
      });
    },

    async acceptOffer({ actor, acceptance, signature, idempotencyKey }) {
      const parsedActor = createActor(actor);
      const parsedAcceptance = createAcceptance(acceptance);
      assertSameSubject(parsedActor, parsedAcceptance.taker);
      invariant(parsedAcceptance.deploymentId === serviceDeploymentId, "DEPLOYMENT_MISMATCH", "acceptance belongs to another deployment");
      validateIdempotencyKey(idempotencyKey);
      opaqueSignature(signature);

      const currentTime = now();
      invariant(Number.isSafeInteger(currentTime), "CLOCK_VALUE", "clock must return integer milliseconds");
      invariant(parsedAcceptance.acceptedAtUnixMs <= currentTime + maxClockSkewMs, "ACCEPTANCE_FUTURE", "acceptance timestamp is too far in the future");
      invariant(currentTime < parsedAcceptance.expiryUnixMs, "ACCEPTANCE_EXPIRED", "acceptance expired");

      const verified = await verifyAcceptanceSignature({
        actor: parsedActor,
        acceptance: parsedAcceptance,
        digestHex: acceptanceDigestHex(parsedAcceptance),
        signature
      });
      invariant(verified === true, "ACCEPT_SIGNATURE_INVALID", "acceptance signature verification failed");

      return repository.acceptOfferAtomic({
        actorSubject: parsedActor.subject,
        acceptance: parsedAcceptance,
        acceptanceHash: acceptanceDigestHex(parsedAcceptance),
        signature,
        nowUnixMs: currentTime,
        idempotencyKey
      });
    }
  });
}
