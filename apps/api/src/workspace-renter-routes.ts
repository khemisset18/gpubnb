import type { FastifyInstance } from 'fastify';
import { BookingStatus, JobType, MachineWorkspaceState, WorkspaceSessionStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { requireSession } from './auth.js';
import { config } from './config.js';
import { evaluateWorkspaceAccess } from './workspace-access-policy.js';
import { issueWorkspaceAccessGrant } from './workspace-access.js';

function safeConnection(metadata: unknown): { ready: boolean; gatewayPath: string | null } {
  if (!metadata || typeof metadata !== 'object') return { ready: false, gatewayPath: null };
  const value = metadata as Record<string, unknown>;
  const path = typeof value.gatewayPath === 'string' ? value.gatewayPath : null;
  if (!path || !path.startsWith('/workspace-gateway/') || path.includes('..')) return { ready: false, gatewayPath: null };
  return { ready: true, gatewayPath: path };
}

const activeBookings=[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE];

export function registerWorkspaceRenterRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  app.post('/machines/:machineId/workspaces/developer/enable-beta', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const machineId=String((request.params as {machineId?:string}).machineId||'');
    const row=await db.machineWorkspace.findFirst({where:{machineId,machine:{ownerId:session.userId},workspace:{slug:'developer'},state:{in:[MachineWorkspaceState.READY,MachineWorkspaceState.LIMITED]}}});
    if(!row)return reply.code(409).send({error:'developer_workspace_analyze_first'});
    await db.machineWorkspace.update({where:{id:row.id},data:{enabledByOwner:true}});
    return {ok:true,machineId,workspaceSlug:'developer',enabled:true};
  });

  app.post('/bookings/:bookingId/workspace/developer', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId},select:{id:true,status:true}});
    if(existing)return existing;
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    const machineWorkspace=await db.machineWorkspace.findFirst({where:{machineId:booking.listing.machineId,enabledByOwner:true,workspace:{slug:'developer'},state:{in:[MachineWorkspaceState.READY,MachineWorkspaceState.LIMITED]}}});
    if(!machineWorkspace)return reply.code(409).send({error:'developer_workspace_not_enabled'});
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:4096,maxCpuCores:2,storageQuotaMiB:10240,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'DEVELOPER_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'DEVELOPER_PREPARATION_REQUESTED'}},
        }});
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'developer',timeoutSeconds:600}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId },
      select: {
        id: true, status: true, expiresAt: true, preparationProgress: true, preparationStep: true,
        connectionType: true, connectionMetadata: true, readyAt: true, startedAt: true,
        machine: { select: { gpuModel: true, vramMiB: true, connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
        booking: { select: { id: true, status: true, startsAt: true, endsAt: true } },
        machineWorkspace: { select: { workspace: { select: { slug: true, name: true } } } },
      },
    });
    if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });
    const policy = evaluateWorkspaceAccess({
      authenticatedUserId: session.userId,
      renterId: session.userId,
      bookingStatus: row.booking.status,
      sessionStatus: row.status,
      expiresAt: row.expiresAt,
      machineConnectivity: row.machine.connectivity,
      machineOperational: row.machine.operational,
      moderationStatus: row.machine.moderationStatus,
      lastHeartbeatAt: row.machine.lastHeartbeatAt,
      heartbeatMaxAgeSeconds: config.HEARTBEAT_MAX_AGE_SECONDS,
    });
    const connection = safeConnection(row.connectionMetadata);
    return {
      sessionId: row.id,
      status: row.status,
      workspace: row.machineWorkspace.workspace,
      gpu: { model: row.machine.gpuModel, vramMiB: row.machine.vramMiB },
      startsAt: row.booking.startsAt,
      endsAt: row.booking.endsAt,
      expiresAt: row.expiresAt,
      preparation: { progress: row.preparationProgress, step: row.preparationStep },
      canOpen: policy.allowed && connection.ready,
      blockedReason: !policy.allowed ? policy.code : connection.ready ? null : 'GATEWAY_NOT_READY',
    };
  });

  app.post('/bookings/:bookingId/workspace/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId },
      select: {
        id: true, renterId: true, status: true, expiresAt: true, connectionMetadata: true,
        machine: { select: { connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
        booking: { select: { status: true } },
      },
    });
    if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });
    const policy = evaluateWorkspaceAccess({
      authenticatedUserId: session.userId,
      renterId: row.renterId,
      bookingStatus: row.booking.status,
      sessionStatus: row.status,
      expiresAt: row.expiresAt,
      machineConnectivity: row.machine.connectivity,
      machineOperational: row.machine.operational,
      moderationStatus: row.machine.moderationStatus,
      lastHeartbeatAt: row.machine.lastHeartbeatAt,
      heartbeatMaxAgeSeconds: config.HEARTBEAT_MAX_AGE_SECONDS,
    });
    if (!policy.allowed) return reply.code(409).send({ error: policy.code.toLowerCase() });
    const connection = safeConnection(row.connectionMetadata);
    if (!connection.ready || !connection.gatewayPath) return reply.code(409).send({ error: 'workspace_gateway_not_ready' });
    const grant = await issueWorkspaceAccessGrant(redis, { userId: session.userId, bookingId, sessionId: row.id });
    return { ...grant, openPath: `${connection.gatewayPath}?grant=${encodeURIComponent(grant.token)}` };
  });
}
