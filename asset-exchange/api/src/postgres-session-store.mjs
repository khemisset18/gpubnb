import { invariant } from "../../core/src/errors.mjs";
import { validateDeploymentId } from "../../core/src/deployment.mjs";

function validateHash(value, field) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "SESSION_HASH", `invalid ${field}`);
  return value;
}

export function createPostgresSessionStore({ pool, deploymentId }) {
  invariant(pool && typeof pool.connect === "function", "SESSION_PG_POOL", "pool.connect required");
  const scopedDeploymentId = validateDeploymentId(deploymentId);

  async function useClient(operation) {
    const client = await pool.connect();
    invariant(client && typeof client.query === "function" && typeof client.release === "function", "SESSION_PG_CLIENT", "valid db client required");
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    async put(sessionHashHex, record) {
      validateHash(sessionHashHex, "session hash");
      validateHash(record.csrfHash, "csrf hash");
      invariant(typeof record.subject === "string" && record.subject.length >= 3 && record.subject.length <= 256, "SESSION_SUBJECT", "invalid session subject");
      invariant(["EXCHANGE_SESSION", "SIGNED_SSO_TICKET"].includes(record.authnMethod), "SESSION_AUTHN", "invalid session authn method");
      invariant(Number.isSafeInteger(record.createdAtUnixMs) && Number.isSafeInteger(record.expiresAtUnixMs) && record.expiresAtUnixMs > record.createdAtUnixMs, "SESSION_TIME", "invalid session timestamps");

      await useClient((client) => client.query({
        text: `INSERT INTO asset_exchange.exchange_sessions (
                 session_hash, deployment_id, subject, authn_method, csrf_hash, created_at, expires_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          sessionHashHex,
          scopedDeploymentId,
          record.subject,
          record.authnMethod,
          record.csrfHash,
          new Date(record.createdAtUnixMs),
          new Date(record.expiresAtUnixMs)
        ]
      }));
    },

    async get(sessionHashHex) {
      validateHash(sessionHashHex, "session hash");
      return useClient(async (client) => {
        const result = await client.query({
          text: `SELECT subject, authn_method, csrf_hash, created_at, expires_at
                 FROM asset_exchange.exchange_sessions
                 WHERE session_hash = $1
                   AND deployment_id = $2
                   AND revoked_at IS NULL`,
          values: [sessionHashHex, scopedDeploymentId]
        });
        if (result.rows.length === 0) return null;
        invariant(result.rows.length === 1, "SESSION_CARDINALITY", "duplicate session rows");
        const row = result.rows[0];
        return {
          subject: row.subject,
          authnMethod: row.authn_method,
          csrfHash: row.csrf_hash,
          createdAtUnixMs: new Date(row.created_at).getTime(),
          expiresAtUnixMs: new Date(row.expires_at).getTime()
        };
      });
    },

    async delete(sessionHashHex) {
      validateHash(sessionHashHex, "session hash");
      await useClient((client) => client.query({
        text: `UPDATE asset_exchange.exchange_sessions
               SET revoked_at = COALESCE(revoked_at, clock_timestamp())
               WHERE session_hash = $1 AND deployment_id = $2`,
        values: [sessionHashHex, scopedDeploymentId]
      }));
    },

    async revokeSubject(subject) {
      invariant(typeof subject === "string" && subject.length >= 3 && subject.length <= 256, "SESSION_SUBJECT", "invalid session subject");
      await useClient((client) => client.query({
        text: `UPDATE asset_exchange.exchange_sessions
               SET revoked_at = COALESCE(revoked_at, clock_timestamp())
               WHERE deployment_id = $1
                 AND subject = $2
                 AND revoked_at IS NULL`,
        values: [scopedDeploymentId, subject]
      }));
    }
  });
}
