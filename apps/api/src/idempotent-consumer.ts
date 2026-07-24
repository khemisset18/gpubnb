import { payloadHash, validateDeliveryKey, validatePayload, validateTopic, type SqlClient } from './reliable-delivery.js';

export interface ConsumedEnvelope {
  id: string;
  consumer: string;
  payload: Record<string, unknown>;
}

export type ConsumeResult = 'processed' | 'duplicate';

export async function consumeExactlyOnce(
  tx: SqlClient,
  envelope: ConsumedEnvelope,
  handler: () => Promise<void>,
): Promise<ConsumeResult> {
  validateDeliveryKey(envelope.id, 'message_id');
  validateTopic(envelope.consumer, 'consumer');
  validatePayload(envelope.payload);
  const digest = payloadHash(envelope.payload);

  const inserted = await tx.$queryRaw<Array<{ inserted: boolean; payloadHash: string }>>`
    WITH attempted AS (
      INSERT INTO "ConsumedMessage" ("consumer", "messageId", "payloadHash")
      VALUES (${envelope.consumer}, ${envelope.id}, ${digest})
      ON CONFLICT ("consumer", "messageId") DO NOTHING
      RETURNING TRUE AS "inserted", "payloadHash"
    )
    SELECT * FROM attempted
    UNION ALL
    SELECT FALSE AS "inserted", "payloadHash"
    FROM "ConsumedMessage"
    WHERE "consumer" = ${envelope.consumer}
      AND "messageId" = ${envelope.id}
      AND NOT EXISTS (SELECT 1 FROM attempted)
    LIMIT 1
  `;

  const row = inserted[0];
  if (!row) throw new Error('consumer_deduplication_failed');
  if (row.payloadHash !== digest) throw new Error('consumer_payload_mismatch');
  if (!row.inserted) return 'duplicate';

  try {
    await handler();
    return 'processed';
  } catch (error) {
    await tx.$executeRaw`
      DELETE FROM "ConsumedMessage"
      WHERE "consumer" = ${envelope.consumer}
        AND "messageId" = ${envelope.id}
        AND "payloadHash" = ${digest}
    `;
    throw error;
  }
}
