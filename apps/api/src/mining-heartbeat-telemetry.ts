import { Prisma } from '@prisma/client';

export type MiningHeartbeatSnapshot = {
  resourceId: string;
  hardwareUuid: string;
  state: 'MINING' | 'STOPPED' | 'QUARANTINED';
  temperatureC: number | null;
  powerWatts: number | null;
  utilizationPercent: number | null;
  hashrate: number | null;
  hashrateUnit: string | null;
  acceptedShares: number | null;
  staleShares: number | null;
  hardwareErrors: number | null;
  uptimeSeconds: number | null;
  poolConnected: boolean;
  sampledAtMs: number | null;
};

type MiningTelemetryTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

const publicSnapshot = (snapshot: MiningHeartbeatSnapshot) => ({
  state: snapshot.state,
  temperatureC: snapshot.temperatureC,
  powerWatts: snapshot.powerWatts,
  utilizationPercent: snapshot.utilizationPercent,
  hashrate: snapshot.hashrate,
  hashrateUnit: snapshot.hashrateUnit,
  acceptedShares: snapshot.acceptedShares,
  staleShares: snapshot.staleShares,
  hardwareErrors: snapshot.hardwareErrors,
  uptimeSeconds: snapshot.uptimeSeconds,
  poolConnected: snapshot.poolConnected,
  sampledAtMs: snapshot.sampledAtMs,
});

export async function syncMiningHeartbeatTelemetry(
  tx: MiningTelemetryTx,
  machineId: string,
  snapshots: readonly MiningHeartbeatSnapshot[],
): Promise<string[]> {
  const updated: string[] = [];
  for (const snapshot of snapshots.slice(0, 64)) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "MiningResource" AS r
         SET "lastTelemetry" = ${JSON.stringify(publicSnapshot(snapshot))}::jsonb,
             "lastTelemetryAt" = CURRENT_TIMESTAMP,
             "lastSeenAt" = CURRENT_TIMESTAMP,
             "updatedAt" = CURRENT_TIMESTAMP
        FROM "Accelerator" AS a
       WHERE r."acceleratorId" = a."id"
         AND r."machineId" = ${machineId}
         AND r."id" = ${snapshot.resourceId}
         AND a."hardwareUuid" = ${snapshot.hardwareUuid}
      RETURNING r."id"
    `);
    if (rows[0]?.id) updated.push(rows[0].id);
  }
  return updated;
}