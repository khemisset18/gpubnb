import { invariant } from "./errors.mjs";
export function createOpenOfferState({ offerId, expiryUnixMs, policyEpoch }) {
  invariant(typeof offerId === "string" && offerId.length >= 8, "OFFER_ID", "invalid offerId");
  invariant(Number.isSafeInteger(expiryUnixMs) && expiryUnixMs > 0, "OFFER_EXPIRY", "invalid expiry");
  invariant(Number.isSafeInteger(policyEpoch) && policyEpoch >= 0, "OFFER_EPOCH", "invalid policy epoch");
  return Object.freeze({ offerId, state: "OPEN", expiryUnixMs, policyEpoch, tradeId: null });
}
export function acceptOffer(current, { tradeId, nowUnixMs, policyEpoch }) {
  invariant(current.state === "OPEN", "OFFER_NOT_OPEN", "offer is not open");
  invariant(Number.isSafeInteger(nowUnixMs), "TIME_TYPE", "authoritative time must be integer milliseconds");
  invariant(nowUnixMs < current.expiryUnixMs, "OFFER_EXPIRED", "offer expired");
  invariant(policyEpoch === current.policyEpoch, "STALE_EPOCH", "stale policy epoch cannot accept offer");
  invariant(typeof tradeId === "string" && tradeId.length >= 8, "TRADE_ID", "invalid tradeId");
  return Object.freeze({ ...current, state: "CONSUMED", tradeId });
}
export function cancelOffer(current, { nowUnixMs }) {
  invariant(current.state === "OPEN", "OFFER_NOT_OPEN", "offer is not open");
  invariant(Number.isSafeInteger(nowUnixMs), "TIME_TYPE", "authoritative time must be integer milliseconds");
  return Object.freeze({ ...current, state: "CANCELLED" });
}
