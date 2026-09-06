import { readFileSync, writeFileSync } from 'node:fs';

function replaceExact(path, oldValue, newValue, expectedCount) {
  const source = readFileSync(path, 'utf8');
  const count = source.split(oldValue).length - 1;
  if (count !== expectedCount) {
    throw new Error(`${path}: expected ${expectedCount} matches, found ${count} for ${JSON.stringify(oldValue)}`);
  }
  writeFileSync(path, source.split(oldValue).join(newValue));
}

const schema = 'apps/api/prisma/schema.prisma';
replaceExact(
  schema,
  '  connectionMetadata Json?\n  lastMetricCounter BigInt @default(0)\n',
  '  connectionMetadata Json?\n  gatewayLastSeenAt DateTime?\n  lastMetricCounter BigInt @default(0)\n',
  1,
);

const gateway = 'apps/api/src/workspace-gateway.ts';
replaceExact(
  gateway,
  'localPort:Number(body.localPort)},...(firstRegistration?',
  'localPort:Number(body.localPort)},gatewayLastSeenAt:readyAt,...(firstRegistration?',
  1,
);
replaceExact(
  gateway,
  'data:{lastMetricCounter:counter}',
  'data:{lastMetricCounter:counter,gatewayLastSeenAt:new Date()}',
  2,
);

const renter = 'apps/api/src/workspace-renter-routes.ts';
replaceExact(
  renter,
  "import { registerWorkspaceGatewayRoutes } from './workspace-gateway.js';\n",
  "import { registerWorkspaceGatewayRoutes } from './workspace-gateway.js';\nimport { isWorkspaceGatewayLive } from './workspace-gateway-liveness.js';\n",
  1,
);

let renterSource = readFileSync(renter, 'utf8');
let selected = 0;
for (const [oldValue, newValue] of [
  ['connectionMetadata: true,', 'connectionMetadata: true, gatewayLastSeenAt: true,'],
  ['connectionMetadata:true,', 'connectionMetadata:true,gatewayLastSeenAt:true,'],
]) {
  const count = renterSource.split(oldValue).length - 1;
  selected += count;
  renterSource = renterSource.split(oldValue).join(newValue);
}
if (selected < 16) throw new Error(`${renter}: expected at least 16 connectionMetadata selects, found ${selected}`);
writeFileSync(renter, renterSource);

replaceExact(
  renter,
  'connectionMetadata:{},preparationProgress:5,',
  'connectionMetadata:{},gatewayLastSeenAt:null,preparationProgress:5,',
  1,
);
replaceExact(
  renter,
  'const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);',
  'const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready && isWorkspaceGatewayLive(row.gatewayLastSeenAt));',
  8,
);
replaceExact(
  renter,
  'canOpen: policy.allowed && connection.ready,',
  'canOpen: policy.allowed && connection.ready && isWorkspaceGatewayLive(row.gatewayLastSeenAt),',
  8,
);
replaceExact(
  renter,
  "blockedReason: !policy.allowed ? policy.code : connection.ready ? null : 'GATEWAY_NOT_READY',",
  "blockedReason: !policy.allowed ? policy.code : !connection.ready ? 'GATEWAY_NOT_READY' : isWorkspaceGatewayLive(row.gatewayLastSeenAt) ? null : 'GATEWAY_STALE',",
  8,
);
replaceExact(
  renter,
  "if (!connection.ready || !connection.gatewayPath) return reply.code(409).send({ error: 'workspace_gateway_not_ready' });",
  "if (!connection.ready || !connection.gatewayPath || !isWorkspaceGatewayLive(row.gatewayLastSeenAt)) return reply.code(409).send({ error: 'workspace_gateway_not_ready' });",
  8,
);

console.log('gateway liveness patch applied');
