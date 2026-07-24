import fs from 'node:fs';

const path = 'apps/api/src/server.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1;
  if (count === 0 && source.includes(after)) return;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  'security import',
  "import { assertTrustedOrigin, constantTimeToken, verifyAgentRequest, recordSecurityFailure } from './security.js';",
  "import { assertTrustedOrigin, constantTimeToken, verifyAgentRequest, verifyAgentRequestV2, recordSecurityFailure } from './security.js';",
);

replaceOnce(
  'accelerator imports',
  "import { sweepOfflineMachines } from './offline-sweep-service.js';",
  "import { sweepOfflineMachines } from './offline-sweep-service.js';\nimport { processAcceleratorHeartbeat } from './accelerator-heartbeat-service.js';\nimport { listOwnerMachineAccelerators, listPublicMachineAccelerators } from './accelerator-public-view.js';",
);

replaceOnce(
  'heartbeat telemetry schema',
  "hardwareChanged:z.boolean().optional()});",
  "hardwareChanged:z.boolean().optional(),telemetry:z.object({schemaVersion:z.literal(2),accelerators:z.unknown()}).passthrough().optional()});",
);

replaceOnce(
  'v2 body verification',
  "if(BigInt(b.counter)<=m.lastCounter)return reply.code(409).send({error:'counter_replay'});const canonical=",
  "if(BigInt(b.counter)<=m.lastCounter)return reply.code(409).send({error:'counter_replay'});if(b.telemetry){const bodyBytes=Buffer.from(JSON.stringify(req.body));const validV2=await verifyAgentRequestV2(redis,b.machineId,m.agentPublicKey,'POST','/agent/heartbeat',bodyBytes,{timestamp:req.headers['x-agent-timestamp'],nonce:req.headers['x-agent-nonce'],bodySha256:req.headers['x-agent-body-sha256'],signature:req.headers['x-agent-signature-v2'],version:req.headers['x-agent-signature-version']});if(!validV2){await recordSecurityFailure(redis,`agent-v2:${b.machineId}`,4);return reply.code(401).send({error:'invalid_agent_body_signature'});}}const canonical=",
);

replaceOnce(
  'active session binding',
  "if(b.sessionId){const active=await db.booking.findFirst({where:{id:b.sessionId,listing:{machineId:m.id},status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE,BookingStatus.DEGRADED]},startsAt:{lte:new Date(Date.now()+5*60_000)},endsAt:{gte:new Date(Date.now()-5*60_000)}}});if(!active)return reply.code(409).send({error:'invalid_session_binding'});}",
  "let activeSession=false;if(b.sessionId){const active=await db.booking.findFirst({where:{id:b.sessionId,listing:{machineId:m.id},status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE,BookingStatus.DEGRADED]},startsAt:{lte:new Date(Date.now()+5*60_000)},endsAt:{gte:new Date(Date.now()-5*60_000)}}});if(!active)return reply.code(409).send({error:'invalid_session_binding'});activeSession=true;}",
);

replaceOnce(
  'heartbeat transaction',
  " const sameGpu=!m.gpuUuid||m.gpuUuid===b.gpuUuid;const canPublish=m.moderationStatus===ModerationStatus.CLEAR&&sameGpu&&b.cudaProbeOk;await db.$transaction(async tx=>{await tx.machine.update({where:{id:m.id},data:{connectivity:MachineConnectivity.ONLINE,operational:b.sessionId?MachineOperational.RUNNING:MachineOperational.AVAILABLE,lastHeartbeatAt:new Date(),keyLastUsedAt:new Date(),lastCounter:BigInt(b.counter),...(b.agentVersion?{agentVersion:b.agentVersion}:{}),...(b.os?{operatingSystem:b.os}:{}),...(b.osVersion?{osVersion:b.osVersion}:{}),...(b.cpu?{cpuModel:b.cpu}:{}),...(b.cpuCount!==undefined?{cpuCount:b.cpuCount}:{}),...(b.ramTotalMiB!==undefined?{ramTotalMiB:b.ramTotalMiB}:{}),...(b.diskTotalMiB!==undefined?{diskTotalMiB:b.diskTotalMiB}:{}),...(b.dockerAvailable!==undefined?{dockerAvailable:b.dockerAvailable}:{}),...(b.nvidiaRuntimeAvailable!==undefined?{nvidiaRuntimeAvailable:b.nvidiaRuntimeAvailable}:{}),...(b.cudaVersion!==undefined?{cudaVersion:b.cudaVersion}:{}),...(b.gpuVendor!==undefined?{gpuVendor:b.gpuVendor}:{}),gpuUuid:b.gpuUuid,gpuModel:b.gpuModel,vramMiB:b.vramMiB,driverVersion:b.driverVersion,lastCudaProbeOk:b.cudaProbeOk,verifiedAt:sameGpu&&b.cudaProbeOk?new Date():m.verifiedAt}});await tx.heartbeat.create({data:{machineId:m.id,counter:BigInt(b.counter),agentTimestamp:new Date(b.timestamp),gpuUtilization:b.gpuUtilization,memoryUsedMiB:b.memoryUsedMiB,temperatureC:b.temperatureC,cudaProbeOk:b.cudaProbeOk,sessionId:b.sessionId,signatureHash:crypto.createHash('sha256').update(b.signature).digest('hex')}});if(canPublish)await tx.gpuListing.updateMany({where:{machineId:m.id,status:{in:[ListingStatus.HIDDEN_OFFLINE,ListingStatus.PENDING_GPU_VERIFICATION]}},data:{status:ListingStatus.ACTIVE}})});return {ok:true,publishable:canPublish};});",
  " const sameGpu=!m.gpuUuid||m.gpuUuid===b.gpuUuid;const legacyPublishable=m.moderationStatus===ModerationStatus.CLEAR&&sameGpu&&b.cudaProbeOk;const heartbeatResult=await db.$transaction(async tx=>{await tx.machine.update({where:{id:m.id},data:{connectivity:MachineConnectivity.ONLINE,operational:b.sessionId?MachineOperational.RUNNING:MachineOperational.AVAILABLE,lastHeartbeatAt:new Date(),keyLastUsedAt:new Date(),lastCounter:BigInt(b.counter),...(b.agentVersion?{agentVersion:b.agentVersion}:{}),...(b.os?{operatingSystem:b.os}:{}),...(b.osVersion?{osVersion:b.osVersion}:{}),...(b.cpu?{cpuModel:b.cpu}:{}),...(b.cpuCount!==undefined?{cpuCount:b.cpuCount}:{}),...(b.ramTotalMiB!==undefined?{ramTotalMiB:b.ramTotalMiB}:{}),...(b.diskTotalMiB!==undefined?{diskTotalMiB:b.diskTotalMiB}:{}),...(b.dockerAvailable!==undefined?{dockerAvailable:b.dockerAvailable}:{}),...(b.nvidiaRuntimeAvailable!==undefined?{nvidiaRuntimeAvailable:b.nvidiaRuntimeAvailable}:{}),...(b.cudaVersion!==undefined?{cudaVersion:b.cudaVersion}:{}),...(b.gpuVendor!==undefined?{gpuVendor:b.gpuVendor}:{}),gpuUuid:b.gpuUuid,gpuModel:b.gpuModel,vramMiB:b.vramMiB,driverVersion:b.driverVersion,lastCudaProbeOk:b.cudaProbeOk,verifiedAt:sameGpu&&b.cudaProbeOk?new Date():m.verifiedAt}});await tx.heartbeat.create({data:{machineId:m.id,counter:BigInt(b.counter),agentTimestamp:new Date(b.timestamp),gpuUtilization:b.gpuUtilization,memoryUsedMiB:b.memoryUsedMiB,temperatureC:b.temperatureC,cudaProbeOk:b.cudaProbeOk,sessionId:b.sessionId,signatureHash:crypto.createHash('sha256').update(b.signature).digest('hex')}});const accelerator=b.telemetry?await processAcceleratorHeartbeat(tx,{machineId:m.id,historicalGpuUuid:m.gpuUuid,sessionActive:activeSession,rawAccelerators:b.telemetry.accelerators}):null;const publishable=legacyPublishable&&(accelerator?.publishable??true);if(publishable)await tx.gpuListing.updateMany({where:{machineId:m.id,status:{in:[ListingStatus.HIDDEN_OFFLINE,ListingStatus.PENDING_GPU_VERIFICATION]}},data:{status:ListingStatus.ACTIVE}});return {publishable,accelerator};},{isolationLevel:'Serializable'});return {ok:true,publishable:heartbeatResult.publishable,acceleratorSecurity:heartbeatResult.accelerator?{severity:heartbeatResult.accelerator.decision.severity,reason:heartbeatResult.accelerator.decision.reason}:null};});",
);

const mineRoute = "app.get('/machines/mine',async(req,reply)=>{const session=await requireSession(req,reply,redis);if(!session)return;const rows=await db.machine.findMany({where:{ownerId:session.userId},select:{id:true,connectivity:true,operational:true,lastHeartbeatAt:true,gpuModel:true,vramMiB:true,verifiedAt:true},orderBy:{lastHeartbeatAt:'desc'}});return rows;});";
const acceleratorRoutes = `${mineRoute}\napp.get('/machines/:machineId/accelerators/manage',async(req,reply)=>{const session=await requireSession(req,reply,redis);if(!session)return;const {machineId}=z.object({machineId:z.string().cuid()}).parse(req.params);const machine=await db.machine.findFirst({where:{id:machineId,ownerId:session.userId},select:{id:true}});if(!machine)return reply.code(404).send({error:'machine_not_found'});return {machineId,accelerators:await listOwnerMachineAccelerators(db,machineId,session.userId)};});\napp.get('/machines/:machineId/accelerators',async(req,reply)=>{const {machineId}=z.object({machineId:z.string().cuid()}).parse(req.params);const published=await db.machine.findFirst({where:{id:machineId,moderationStatus:ModerationStatus.CLEAR,listings:{some:{status:ListingStatus.ACTIVE}}},select:{id:true}});if(!published)return reply.code(404).send({error:'published_machine_not_found'});return {machineId,accelerators:await listPublicMachineAccelerators(db,machineId)};});`;
replaceOnce('accelerator routes', mineRoute, acceleratorRoutes);

fs.writeFileSync(path, source);
console.log('Accelerator server integration applied safely.');
