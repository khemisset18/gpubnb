import { createUnsignedOffer, offerDigestHex } from "../../core/src/offer.mjs";
import { createAcceptance, acceptanceDigestHex } from "../../core/src/acceptance.mjs";
import { invariant } from "../../core/src/errors.mjs";
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
  now = () => Date.now()
}) {
  invariant(repository && typeof repository === "object", "OFFER_REPOSITORY", "repository required");
  for (const method of ["insertOfferAtomic", "getOfferById", "cancelOfferAtomic", "acceptOfferAtomic"]) {
    invariant(typeof repository[method] === "function", "OFFER_REPOSITORY_METHOD", `repository.${method} required`);
  }
  invariant(typeof verifyOfferSignature === "function", "OFFER_SIGNATURE_VERIFIER", "offer signature verifier required");
  invariant(typeof verifyAcceptanceSignature === "function", "ACCEPT_SIGNATURE_VERIFIER", "acceptance signature verifier required");
  invariant(typeof now === "function", "CLOCK", "authoritative clock required");

  return Object.freeze({
    async publishOffer({ actor, offer, signature, idempotencyKey }) {
      const parsedActor = createActor(actor);
      const parsedOffer = createUnsignedOffer(offer);
      assertSameSubject(parsedActor, parsedOffer.maker);
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

    async cancelOffer({ actor, offerId, idempotencyKey }) {
      const parsedActor = createActor(actor);
      validateIdempotencyKey(idempotencyKey);
      invariant(typeof offerId === "string" && offerId.length >= 8 && offerId.length <= 128, "OFFER_ID", "invalid offerId");

      const stored = await repository.getOfferById(offerId);
      invariant(stored !== null && stored !== undefined, "OFFER_NOT_FOUND", "offer not found");
      assertSameSubject(parsedActor, stored.makerSubject);
      invariant(stored.state === "OPEN", "OFFER_NOT_OPEN", "offer is not open");

      return repository.cancelOfferAtomic({
        offerId,
        makerSubject: parsedActor.subject,
        nowUnixMs: now(),
        idempotencyKey
      });
    },

    async acceptOffer({ actor, acceptance, signature, idempotencyKey }) {
      const parsedActor = createActor(actor);
      const parsedAcceptance = createAcceptance(acceptance);
      assertSameSubject(parsedActor, parsedAcceptance.taker);
      validateIdempotencyKey(idempotencyKey);
      opaqueSignature(signature);

      const currentTime = now();
      invariant(Number.isSafeInteger(currentTime), "CLOCK_VALUE", "clock must return integer milliseconds");
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
