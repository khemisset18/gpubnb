import { parseSignedOffer, offerDigestHex } from "../../core/src/offer.mjs";
import { createAcceptance, acceptanceDigestHex } from "../../core/src/acceptance.mjs";
import { createCancellation, cancellationDigestHex } from "../../core/src/cancellation.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";
import { resolveAssetCatalogByIdentity } from "../../core/src/asset-registry.mjs";
import { assertSameSubject, createActor, validateIdempotencyKey } from "./authz.mjs";

// Pearl is not yet backed by a verified canonical asset identity. The
// marketplace research entry cannot be used to publish signed live offers.
// Keep this in the real offer-service boundary, before signature verification
// and before all repository writes: display metadata is NOT authorization.
export function assertPearlOfferExposureGate(offer) {
  for (const identity of [offer.giveAsset, offer.wantAsset]) {
    if (identity.chainId !== "pearl") continue;
    const record = resolveAssetCatalogByIdentity(identity);
    invariant(
      record !== null &&
      record.registryId === "pearl-mainnet-native" &&
      record.identityReady === true &&
      record.capabilities.newOffersEnabled === true &&
      record.capabilities.newTradesEnabled === false &&
      record.capabilities.automaticSettlementSupported === false &&
      record.routing.settlement === null,
      "PRL_OFFER_UNQUALIFIED",
      "Pearl offers are blocked pending independent identity and policy qualification"
    );
  }
}


// Harden acceptance of offers stored before Pearl's publication gate existed.
// A database row's canonical asset keys—not a caller-supplied symbol—are the
// security inputs. Unknown/malformed keys must not bypass this review.
export function assertStoredOfferAssetPolicy(stored) {
  invariant(stored && typeof stored === "object" && !Array.isArray(stored),
    "ACCEPT_OFFER_NOT_FOUND", "stored offer required");
  for (const field of ["giveAssetKey", "wantAssetKey"]) {
    const key = stored[field];
    invariant(typeof key === "string" && key.length > 0 && key.length <= 512,
      "ACCEPT_ASSET_KEY_MISSING", "stored asset identity missing");
    const parts = key.split("|");
    const chain = parts[0].trim().toLowerCase();
    invariant(chain !== "pearl" && chain !== "prl",
      "PRL_ACCEPT_UNQUALIFIED", "unqualified Pearl offer acceptance blocked");
    invariant(parts.length === 5 &&
      /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(parts[0]) &&
      /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(parts[1]) &&
      ["NATIVE", "TOKEN", "NFT"].includes(parts[2]) &&
      parts[3].length > 0 && parts[3].length <= 256 &&
      /^(0|[1-9][0-9]{0,2})$/.test(parts[4]) &&
      Number(parts[4]) <= 255,
      "ACCEPT_ASSET_KEY_INVALID", "stored asset identity is not canonical");
  }
}

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
      const parsedOffer = parseSignedOffer(offer);
      assertPearlOfferExposureGate(parsedOffer);
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

      // Read-only preflight: prevent historic PRL offers on BOTH sides
      // before invoking any external signature verifier or write method.
      // The DB trade-insert/consumption triggers remain the atomic authority
      // against direct DB calls and races (migration 010, deployment blocked).
      const storedOffer = await repository.getOfferById(parsedAcceptance.offerId);
      invariant(storedOffer !== null && storedOffer !== undefined,
        "OFFER_NOT_FOUND", "offer not found");
      assertStoredOfferAssetPolicy(storedOffer);
      invariant(storedOffer.state === "OPEN",
        "OFFER_NOT_OPEN", "offer is not open");
      invariant(storedOffer.offerHash === parsedAcceptance.offerHash,
        "ACCEPT_OFFER_HASH_MISMATCH", "offer hash mismatch");
      invariant(storedOffer.policyEpoch === parsedAcceptance.policyEpoch,
        "ACCEPT_EPOCH_MISMATCH", "policy epoch mismatch");

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
