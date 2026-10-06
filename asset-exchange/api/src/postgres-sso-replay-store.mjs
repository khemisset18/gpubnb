import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

export function createPostgresSsoReplayStore({ pool, deploymentId }) {
  invariant(pool && typeof pool.connect === "function", "SSO_PG_POOL", "pool.connect required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);

  return Object.freeze({
    async consume({ jti, issuer, subject, expiresAtUnixMs }) {
      invariant(typeof jti === "string" && /^[A-Za-z0-9._:-]{16,128}$/.test(jti), "SSO_JTI", "invalid jti");
      invariant(typeof issuer === "string" && issuer.length >= 3 && issuer.length <= 256, "SSO_ISSUER", "invalid issuer");
      invariant(typeof subject === "string" && subject.length >= 3 && subject.length <= 256, "SSO_SUBJECT", "invalid subject");
      invariant(Number.isSafeInteger(expiresAtUnixMs) && expiresAtUnixMs > 0, "SSO_EXP", "invalid expiry");

      const client = await pool.connect();
      try {
        const result = await client.query({
          text: `INSERT INTO asset_exchange.consumed_sso_tickets (
                   deployment_id, jti, issuer, subject, expires_at
                 ) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (deployment_id, jti) DO NOTHING
                 RETURNING jti`,
          values: [scopedDeploymentId, jti, issuer, subject, new Date(expiresAtUnixMs)]
        });
        return result.rows.length === 1;
      } finally {
        client.release();
      }
    }
  });
}

export function createMemorySsoReplayStore() {
  const seen = new Set();
  return Object.freeze({
    async consume({ jti }) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    }
  });
}
