import type { FastifyInstance } from 'fastify';
import { BookingStatus, JobStatus, JobType, MachineWorkspaceState, WorkspaceSessionStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { requireSession } from './auth.js';
import { config } from './config.js';
import { evaluateWorkspaceAccess } from './workspace-access-policy.js';
import { issueWorkspaceAccessGrant } from './workspace-access.js';
import { registerWorkspaceGatewayRoutes } from './workspace-gateway.js';
import { ensureCompatibleMachineWorkspace } from './machine-workspace-catalog.js';

function safeConnection(metadata: unknown): { ready: boolean; gatewayPath: string | null } {
  if (!metadata || typeof metadata !== 'object') return { ready: false, gatewayPath: null };
  const value = metadata as Record<string, unknown>;
  const path = typeof value.gatewayPath === 'string' ? value.gatewayPath : null;
  if (!path || !path.startsWith('/workspace-gateway/') || path.includes('..')) return { ready: false, gatewayPath: null };
  return { ready: true, gatewayPath: path };
}

const activeBookings: BookingStatus[]=[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE];
const terminalJobs: JobStatus[]=[JobStatus.COMPLETED,JobStatus.FAILED,JobStatus.CANCELLED,JobStatus.TIMED_OUT,JobStatus.REJECTED,JobStatus.QUARANTINED];
const retryableSessions: WorkspaceSessionStatus[]=[WorkspaceSessionStatus.FAILED,WorkspaceSessionStatus.CANCELLED,WorkspaceSessionStatus.TIMED_OUT];

function preparationPhase(status: WorkspaceSessionStatus, step: string | null, jobStatus: JobStatus | null): string {
  if (status !== WorkspaceSessionStatus.PREPARING) return status;
  if (step === 'AGENT_RECONNECTING') return 'RECONNECTING_AGENT';
  if (step === 'VERIFYING_WORKSPACE' || step === 'WORKSPACE_VERIFIED') return 'VERIFYING_WORKSPACE';
  if (step === 'VERIFYING_IMAGE_DIGEST') return 'VERIFYING_IMAGE';
  if (step === 'PULLING_IMAGE' || step === 'IMAGE_CACHE_READY' || jobStatus === JobStatus.DOWNLOADING) return 'DOWNLOADING_IMAGE';
  if (jobStatus === JobStatus.PREPARING || jobStatus === JobStatus.RUNNING) return 'STARTING_WORKSPACE';
  return 'WAITING_FOR_HOST';
}

export function registerWorkspaceRenterRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  registerWorkspaceGatewayRoutes(app,db,redis);

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
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    // Publishing an ACTIVE listing is the owner's global consent to secure rentals.
    // The renter chooses the compatible workspace; there is no per-workspace owner
    // installation/activation step in the booking path.
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'developer'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'developer_workspace_incompatible'});}
    // Scoped to this booking's *developer* machineWorkspace, not the booking alone: a
    // booking can also carry a compute session created automatically on funding
    // (ensureComputePreparation). Matching on bookingId alone would silently return
    // that unrelated session and never create the Developer one the renter asked for.
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
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
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'developer',timeoutSeconds:1200}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.post('/bookings/:bookingId/workspace/retry', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const row=await db.workspaceSession.findFirst({
      where:{bookingId,renterId:session.userId,status:{in:retryableSessions},machineWorkspace:{workspace:{slug:'developer'}},booking:{status:{in:activeBookings},endsAt:{gt:new Date()}}},
      select:{id:true,machineId:true,machineWorkspaceId:true,booking:{select:{endsAt:true}}},
    });
    if(!row)return reply.code(409).send({error:'workspace_retry_not_available'});
    const active=await db.job.findFirst({where:{bookingId,type:JobType.WORKSPACE_PREPARE,status:{notIn:terminalJobs}},select:{id:true}});
    if(active)return reply.code(409).send({error:'workspace_preparation_already_active',jobId:active.id});
    const retried=await db.$transaction(async tx=>{
      const reset=await tx.workspaceSession.updateMany({
        where:{id:row.id,status:{in:retryableSessions}},
        data:{status:WorkspaceSessionStatus.PREPARING,jobId:null,endedAt:null,terminationReason:null,readyAt:null,startedAt:null,connectionMetadata:{},preparationProgress:5,preparationStep:'RETRY_REQUESTED',preparationRequestedAt:new Date(),preparationStartedAt:null,preparationCompletedAt:null,preparationAttempts:{increment:1},expiresAt:row.booking.endsAt},
      });
      if(reset.count!==1)return null;
      const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:row.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'developer',timeoutSeconds:1200}}});
      return tx.workspaceSession.update({where:{id:row.id},data:{jobId:job.id,events:{create:{actorType:'RENTER',actorId:session.userId,action:'DEVELOPER_PREPARATION_RETRIED'}}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
    });
    return retried??reply.code(409).send({error:'workspace_retry_raced'});
  });

  app.get('/bookings/:bookingId/workspace', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // This route (and /workspace/access below) is the Developer surface specifically -
    // a booking may separately carry an automatic compute session created on funding
    // (ensureComputePreparation); scoping by workspace slug keeps that unrelated
    // session from ever being returned here.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'developer' } } },
      select: {
        id: true, status: true, expiresAt: true, preparationProgress: true, preparationStep: true,
        preparationAttempts: true, preparationRequestedAt: true, preparationStartedAt: true,
        preparationCompletedAt: true, endedAt: true, updatedAt: true,
        connectionType: true, connectionMetadata: true, readyAt: true, startedAt: true,
        job: { select: { status: true, errorCode: true, createdAt: true, updatedAt: true, startedAt: true, finishedAt: true } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null);
    const preparationStart = row.preparationStartedAt ?? row.preparationRequestedAt ?? row.job?.createdAt ?? row.updatedAt;
    const preparationEnd = row.preparationCompletedAt ?? row.endedAt ?? row.job?.finishedAt ?? new Date();
    return {
      sessionId: row.id,
      status: row.status,
      workspace: row.machineWorkspace.workspace,
      gpu: { model: row.machine.gpuModel, vramMiB: row.machine.vramMiB },
      startsAt: row.booking.startsAt,
      endsAt: row.booking.endsAt,
      expiresAt: row.expiresAt,
      preparation: {
        progress: row.preparationProgress,
        step: row.preparationStep,
        phase,
        attempts: row.preparationAttempts,
        elapsedSeconds: Math.max(0,Math.round((preparationEnd.getTime()-preparationStart.getTime())/1000)),
        updatedAt: row.job?.updatedAt ?? row.updatedAt,
        jobStatus: row.job?.status ?? null,
        errorCode: row.job?.errorCode ?? null,
      },
      retryable: activeBookings.includes(row.booking.status) && retryableSessions.includes(row.status),
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
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'developer' } } },
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
