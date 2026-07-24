import fs from 'node:fs';

const file = 'apps/api/src/server.ts';
let source = fs.readFileSync(file, 'utf8');

const importNeedle = "import { validatedUsageIncrement } from './workspace-usage.js';";
const importReplacement = `${importNeedle}\nimport { sweepOfflineMachines } from './offline-sweep-service.js';`;
if (!source.includes("from './offline-sweep-service.js'")) {
  if (!source.includes(importNeedle)) throw new Error('workspace usage import not found');
  source = source.replace(importNeedle, importReplacement);
}

const oldRoute = "app.post('/internal/sweep-offline',async(req,reply)=>{if(!constantTimeToken(req.headers.authorization?.replace(/^Bearer\\s+/i,''),config.INTERNAL_SERVICE_TOKEN))return reply.code(401).send({error:'unauthorized'});const cutoff=new Date(Date.now()-config.HEARTBEAT_OFFLINE_SECONDS*1000);const rows=await db.machine.findMany({where:{lastHeartbeatAt:{lt:cutoff},connectivity:MachineConnectivity.ONLINE},select:{id:true}});const ids=rows.map(x=>x.id);if(ids.length)await db.$transaction([db.machine.updateMany({where:{id:{in:ids}},data:{connectivity:MachineConnectivity.OFFLINE,operational:MachineOperational.UNAVAILABLE}}),db.gpuListing.updateMany({where:{machineId:{in:ids},status:ListingStatus.ACTIVE},data:{status:ListingStatus.HIDDEN_OFFLINE}})]);return {hidden:ids.length}});";
const newRoute = "app.post('/internal/sweep-offline',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{if(!constantTimeToken(req.headers.authorization?.replace(/^Bearer\\s+/i,''),config.INTERNAL_SERVICE_TOKEN))return reply.code(401).send({error:'unauthorized'});const result=await sweepOfflineMachines(db,new Date(),config.HEARTBEAT_OFFLINE_SECONDS);req.log.info({...result,cutoff:result.cutoff.toISOString()},'offline_sweep_completed');return {...result,cutoff:result.cutoff.toISOString()}});";
if (!source.includes('sweepOfflineMachines(db,new Date()')) {
  if (!source.includes(oldRoute)) throw new Error('legacy sweep route not found');
  source = source.replace(oldRoute, newRoute);
}

fs.writeFileSync(file, source);
