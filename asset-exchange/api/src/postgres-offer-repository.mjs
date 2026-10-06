import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

function signatureBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  invariant(typeof value === "string", "PG_SIGNATURE_TYPE", "signature must be bytes or string");
  return Buffer.from(value, "utf8");
}

function requestHash(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

async function withTransaction(pool, operation) {
  invariant(pool && typeof pool.connect === "function", "PG_POOL", "pool.connect required");
  const client = await pool.connect();
  invariant(client && typeof client.query === "function", "PG_CLIENT", "connected client.query required");
  invariant(typeof client.release === "function", "PG_CLIENT_RELEASE", "connected client.release required");

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresOfferRepository({ pool, deploymentId }) {
  const scopedDeploymentId = validateDeploymentId(deploymentId);

  return Object.freeze({
    async insertOfferAtomic({ actorSubject, offer, offerHash, signature, idempotencyKey }) {
      invariant(offer.deploymentId === scopedDeploymentId, "PG_DEPLOYMENT_MISMATCH", "offer deployment mismatch");
      invariant(actorSubject === offer.maker, "PG_MAKER_MISMATCH", "maker subject mismatch");

      const sig = signatureBytes(signature);
      const reqHash = requestHash({
        operation: "PUBLISH_OFFER",
        deploymentId: scopedDeploymentId,
        actorSubject,
        offerHash,
        signatureHash: createHash("sha256").update(sig).digest("hex")
      });

      return withTransaction(pool, async (client) => {
        const result = await client.query({
          text: `SELECT status, offer_id
                 FROM asset_exchange.publish_offer_atomic(
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
                 )`,
          values: [
            scopedDeploymentId,
            offer.offerId,
            actorSubject,
            offerHash,
            canonicalBytes(offer),
            sig,
            "VERIFIED_EXTERNAL_V1",
            offer.giveAssetKey,
            offer.giveAmountAtomic,
            offer.wantAssetKey,
            offer.wantAmountAtomic,
            offer.nonce,
            offer.policyEpoch,
            offer.feePolicy.policyId,
            offer.feePolicy.version,
            new Date(offer.expiryUnixMs),
            idempotencyKey,
            reqHash
          ]
        });
        invariant(result.rows?.length === 1, "PG_PUBLISH_RESULT", "unexpected publish result");
        return { status: result.rows[0].status, offerId: result.rows[0].offer_id };
      });
    },

    async getOfferById(offerId) {
      invariant(typeof offerId === "string" && offerId.length >= 8 && offerId.length <= 128, "PG_OFFER_ID", "invalid offerId");
      const client = await pool.connect();
      try {
        const result = await client.query({
          text: `SELECT offer_id, maker_subject, state, offer_hash, policy_epoch
                 FROM asset_exchange.offers
                 WHERE deployment_id = $1 AND offer_id = $2`,
          values: [scopedDeploymentId, offerId]
        });
        if (result.rows.length === 0) return null;
        invariant(result.rows.length === 1, "PG_OFFER_CARDINALITY", "duplicate offer rows detected");
        const row = result.rows[0];
        return Object.freeze({
          offerId: row.offer_id,
          makerSubject: row.maker_subject,
          state: row.state,
          offerHash: row.offer_hash,
          policyEpoch: Number(row.policy_epoch)
        });
      } finally {
        client.release();
      }
    },

    async cancelOfferAtomic({ offerId, makerSubject, idempotencyKey }) {
      const reqHash = requestHash({
        operation: "CANCEL_OFFER",
        deploymentId: scopedDeploymentId,
        offerId,
        makerSubject
      });

      return withTransaction(pool, async (client) => {
        const result = await client.query({
          text: `SELECT status, offer_id
                 FROM asset_exchange.cancel_offer_atomic($1,$2,$3,$4,$5)`,
          values: [scopedDeploymentId, offerId, makerSubject, idempotencyKey, reqHash]
        });
        invariant(result.rows?.length === 1, "PG_CANCEL_RESULT", "unexpected cancel result");
        return { status: result.rows[0].status, offerId: result.rows[0].offer_id };
      });
    },

    async acceptOfferAtomic({ actorSubject, acceptance, acceptanceHash, signature, idempotencyKey }) {
      invariant(acceptance.deploymentId === scopedDeploymentId, "PG_DEPLOYMENT_MISMATCH", "acceptance deployment mismatch");
      invariant(actorSubject === acceptance.taker, "PG_TAKER_MISMATCH", "taker subject mismatch");

      const sig = signatureBytes(signature);
      const reqHash = requestHash({
        operation: "ACCEPT_OFFER",
        deploymentId: scopedDeploymentId,
        actorSubject,
        acceptanceHash,
        signatureHash: createHash("sha256").update(sig).digest("hex")
      });

      return withTransaction(pool, async (client) => {
        const result = await client.query({
          text: `SELECT status, trade_id
                 FROM asset_exchange.accept_offer_atomic(
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
                 )`,
          values: [
            scopedDeploymentId,
            acceptance.offerId,
            acceptance.tradeId,
            actorSubject,
            acceptance.offerHash,
            acceptance.policyEpoch,
            acceptanceHash,
            sig,
            idempotencyKey,
            reqHash
          ]
        });
        invariant(result.rows?.length === 1, "PG_ACCEPT_RESULT", "unexpected accept result");
        return { status: result.rows[0].status, tradeId: result.rows[0].trade_id };
      });
    }
  });
}

export { withTransaction };
