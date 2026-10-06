import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

export function createPostgresAdminRepository({ pool, deploymentId }) {
  invariant(pool && typeof pool.connect === "function", "ADMIN_PG_POOL", "pool.connect required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);

  async function use(operation) {
    const client = await pool.connect();
    try { return await operation(client); }
    finally { client.release(); }
  }

  return Object.freeze({
    async getOperatorState() {
      return use(async (client) => {
        const result = await client.query({
          text: `SELECT mode, policy_epoch, config_hash, active_fee_policy_id, active_fee_policy_version
                 FROM asset_exchange.operator_state
                 WHERE singleton = TRUE`,
          values: []
        });
        invariant(result.rows.length === 1, "ADMIN_OPERATOR_STATE", "operator state missing");
        const row = result.rows[0];
        return Object.freeze({
          mode: row.mode,
          policyEpoch: Number(row.policy_epoch),
          configHash: row.config_hash,
          activeFeePolicyId: row.active_fee_policy_id,
          activeFeePolicyVersion: row.active_fee_policy_version === null ? null : Number(row.active_fee_policy_version)
        });
      });
    },

    async activateFeePolicyAtomic(input) {
      invariant(input.deploymentId === scopedDeploymentId, "ADMIN_DEPLOYMENT_MISMATCH", "deployment mismatch");
      return use(async (client) => {
        await client.query("BEGIN");
        try {
          const p = input.policy;
          const result = await client.query({
            text: `SELECT status, policy_id, policy_version, rate_bps
                   FROM asset_exchange.activate_fee_policy_atomic(
                     $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
                   )`,
            values: [
              scopedDeploymentId,
              input.actorSubject,
              input.credentialId,
              input.challengeHash,
              input.expectedConfigHash,
              p.policyId,
              p.version,
              p.rateBps,
              p.payerRole,
              p.feeAssetKey,
              p.recipient,
              p.minimumAtomic,
              p.maximumAtomic,
              input.policyHash,
              input.afterConfigHash,
              input.auditId
            ]
          });
          await client.query("COMMIT");
          invariant(result.rows.length === 1, "ADMIN_ACTIVATE_RESULT", "unexpected activation result");
          const row = result.rows[0];
          return { status: row.status, policyId: row.policy_id, version: Number(row.policy_version), rateBps: Number(row.rate_bps) };
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch {}
          throw error;
        }
      });
    }
  });
}
