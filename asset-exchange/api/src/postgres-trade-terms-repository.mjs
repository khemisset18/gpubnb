import { createHash } from "node:crypto";
import { canonicalBytes } from "../../core/src/canonical.mjs";
import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

function signatureBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  invariant(typeof value === "string", "TERMS_SIGNATURE_TYPE", "signature must be bytes or string");
  const out = Buffer.from(value, "utf8");
  invariant(out.length >= 1 && out.length <= 8192, "TERMS_SIGNATURE_LENGTH", "invalid signature length");
  return out;
}

function requestHash(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

export function createPostgresTradeTermsRepository({ pool, deploymentId }) {
  invariant(pool && typeof pool.connect === "function", "TERMS_PG_POOL", "pool.connect required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);

  async function withClient(operation) {
    const client = await pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    async getTradeById(tradeId) {
      invariant(typeof tradeId === "string" && tradeId.length >= 8 && tradeId.length <= 128, "TERMS_TRADE_ID", "invalid trade id");
      return withClient(async (client) => {
        const result = await client.query({
          text: `SELECT trade_id, deployment_id, offer_hash, maker_subject, taker_subject,
                        policy_epoch, fee_policy_id, fee_policy_version, state,
                        terms_hash, signed_terms_a, signed_terms_b
                 FROM asset_exchange.trades
                 WHERE deployment_id = $1 AND trade_id = $2`,
          values: [scopedDeploymentId, tradeId]
        });
        if (result.rows.length === 0) return null;
        invariant(result.rows.length === 1, "TERMS_TRADE_CARDINALITY", "duplicate trade rows detected");
        const row = result.rows[0];
        return Object.freeze({
          tradeId: row.trade_id,
          deploymentId: row.deployment_id,
          offerHash: row.offer_hash,
          makerSubject: row.maker_subject,
          takerSubject: row.taker_subject,
          policyEpoch: Number(row.policy_epoch),
          feePolicyId: row.fee_policy_id,
          feePolicyVersion: Number(row.fee_policy_version),
          state: row.state,
          termsHash: row.terms_hash,
          makerSigned: row.signed_terms_a !== null,
          takerSigned: row.signed_terms_b !== null
        });
      });
    },

    async submitTermsSignatureAtomic({
      actorSubject,
      role,
      tradeId,
      termsHash,
      signature,
      idempotencyKey
    }) {
      const sig = signatureBytes(signature);
      const reqHash = requestHash({
        operation: "SUBMIT_TRADE_TERMS_SIGNATURE",
        deploymentId: scopedDeploymentId,
        tradeId,
        actorSubject,
        role,
        termsHash,
        signatureHash: createHash("sha256").update(sig).digest("hex")
      });

      return withClient(async (client) => {
        await client.query("BEGIN");
        try {
          const result = await client.query({
            text: `SELECT status, trade_id
                   FROM asset_exchange.submit_trade_terms_signature_atomic(
                     $1,$2,$3,$4,$5,$6,$7,$8
                   )`,
            values: [
              scopedDeploymentId,
              tradeId,
              actorSubject,
              role,
              termsHash,
              sig,
              idempotencyKey,
              reqHash
            ]
          });
          await client.query("COMMIT");
          invariant(result.rows.length === 1, "TERMS_SUBMIT_RESULT", "unexpected terms signature result");
          return {
            status: result.rows[0].status,
            tradeId: result.rows[0].trade_id
          };
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch {}
          throw error;
        }
      });
    }
  });
}
