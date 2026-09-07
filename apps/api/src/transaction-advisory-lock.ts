import { Prisma } from '@prisma/client';

/**
 * Best-effort single-run fencing for periodic DB jobs.
 *
 * The lock lives only for the current PostgreSQL transaction, so it is released
 * automatically on commit, rollback, connection loss, or process crash. `false`
 * means another replica already owns the same task and this tick should be skipped.
 */
export async function tryTransactionAdvisoryLock(
  tx: Prisma.TransactionClient,
  taskName: string,
): Promise<boolean> {
  if (!/^[a-z0-9:_-]{3,80}$/i.test(taskName)) throw new Error('invalid_advisory_task_name');
  const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${taskName}, 0)) AS acquired
  `);
  return rows[0]?.acquired === true;
}
