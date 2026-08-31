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

export function safeConnection(metadata: unknown): { ready: boolean; gatewayPath: string | null } {
  if (!metadata || typeof metadata !== 'object') return { ready: false, gatewayPath: null };
  const value = metadata as Record<string, unknown>;
  const path = typeof value.gatewayPath === 'string' ? value.gatewayPath : null;
  if (!path || !path.startsWith('/workspace-gateway/') || path.includes('..')) return { ready: false, gatewayPath: null };
  return { ready: true, gatewayPath: path };
}

const activeBookings: BookingStatus[]=[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE];
const terminalJobs: JobStatus[]=[JobStatus.COMPLETED,JobStatus.FAILED,JobStatus.CANCELLED,JobStatus.TIMED_OUT,JobStatus.REJECTED,JobStatus.QUARANTINED];
const retryableSessions: WorkspaceSessionStatus[]=[WorkspaceSessionStatus.FAILED,WorkspaceSessionStatus.CANCELLED,WorkspaceSessionStatus.TIMED_OUT];

export function preparationPhase(status: WorkspaceSessionStatus, step: string | null, jobStatus: JobStatus | null, connectionReady: boolean): string {
  // The container/runtime finishing (status READY) is not the same fact as the
  // gateway tunnel being registered and openable (connectionReady). Reporting
  // raw "READY" here when the workspace cannot actually be opened yet is
  // exactly the misleading state this phase exists to prevent - callers must
  // see a distinct, still-preparing phase until both are true.
  if (status === WorkspaceSessionStatus.READY && !connectionReady) return 'GATEWAY_NOT_READY';
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
        // Auto-funding may have queued the private-beta GPU diagnostic just before
        // this Developer request. A queued diagnostic is now superseded; cancelling
        // it here prevents it from delaying the real workspace job. An already
        // running diagnostic is allowed to finish, while the reconciler's atomic
        // Developer-session guard prevents it from closing this booking.
        await tx.job.updateMany({
          where:{bookingId,type:JobType.GPU_DIAGNOSTIC,status:JobStatus.QUEUED},
          data:{status:JobStatus.CANCELLED,errorCode:'superseded_by_developer_workspace',finishedAt:new Date()},
        });
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
    // Not scoped to a single slug: a booking can carry a Developer session, a
    // Data session, or (Developer specifically) both alongside its Compute one -
    // retry just needs to find whichever gateway-backed session on this booking
    // is actually retryable right now, then re-enqueue WORKSPACE_PREPARE for
    // that same workspace.
    const row=await db.workspaceSession.findFirst({
      where:{bookingId,renterId:session.userId,status:{in:retryableSessions},machineWorkspace:{workspace:{slug:{in:['developer','data','ai','video','audio','api','mobile']}}},booking:{status:{in:activeBookings},endsAt:{gt:new Date()}}},
      select:{id:true,machineId:true,machineWorkspaceId:true,booking:{select:{endsAt:true}},machineWorkspace:{select:{workspace:{select:{slug:true}}}}},
    });
    if(!row)return reply.code(409).send({error:'workspace_retry_not_available'});
    const workspaceSlug=row.machineWorkspace.workspace.slug;
    const active=await db.job.findFirst({where:{bookingId,type:JobType.WORKSPACE_PREPARE,status:{notIn:terminalJobs}},select:{id:true}});
    if(active)return reply.code(409).send({error:'workspace_preparation_already_active',jobId:active.id});
    const retried=await db.$transaction(async tx=>{
      const reset=await tx.workspaceSession.updateMany({
        where:{id:row.id,status:{in:retryableSessions}},
        data:{status:WorkspaceSessionStatus.PREPARING,jobId:null,endedAt:null,terminationReason:null,readyAt:null,startedAt:null,connectionMetadata:{},preparationProgress:5,preparationStep:'RETRY_REQUESTED',preparationRequestedAt:new Date(),preparationStartedAt:null,preparationCompletedAt:null,preparationAttempts:{increment:1},expiresAt:row.booking.endsAt},
      });
      if(reset.count!==1)return null;
      const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:row.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug,timeoutSeconds:1200}}});
      return tx.workspaceSession.update({where:{id:row.id},data:{jobId:job.id,events:{create:{actorType:'RENTER',actorId:session.userId,action:'DEVELOPER_PREPARATION_RETRIED'}}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
    });
    return retried??reply.code(409).send({error:'workspace_retry_raced'});
  });

  app.post('/bookings/:bookingId/workspace/data', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'data'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'data_workspace_incompatible'});}
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:4096,maxCpuCores:2,storageQuotaMiB:10240,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'DATA_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'DATA_PREPARATION_REQUESTED'}},
        }});
        // Larger requested budget than Developer's default: the official Jupyter
        // data-science image is several GB (see runtime_images.DEFAULT_DATA_IMAGE),
        // capped server-side by prepare_workspace's own 1800s ceiling regardless.
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'data',timeoutSeconds:1800}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace/data/status', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // Mirrors GET /bookings/:bookingId/workspace below, scoped to the Data
    // surface instead of Developer - kept as a parallel route (not a shared
    // :slug param) so neither surface's locked behavior can regress the other.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'data' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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

  app.post('/bookings/:bookingId/workspace/data/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'data' } } },
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

  app.post('/bookings/:bookingId/workspace/ai', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'ai'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'ai_workspace_incompatible'});}
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:8192,maxCpuCores:2,storageQuotaMiB:30720,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'AI_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'AI_PREPARATION_REQUESTED'}},
        }});
        // Same rationale as Data's larger budget: the CUDA+PyTorch+Jupyter
        // image is larger still (see runtime_images.DEFAULT_AI_IMAGE), capped
        // server-side by prepare_workspace's own 1800s ceiling regardless.
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'ai',timeoutSeconds:1800}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace/ai/status', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // Mirrors GET /bookings/:bookingId/workspace/data/status above, scoped to
    // the AI surface - kept as its own parallel route for the same reason.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'ai' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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

  app.post('/bookings/:bookingId/workspace/ai/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'ai' } } },
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

  app.post('/bookings/:bookingId/workspace/video', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'video'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'video_workspace_incompatible'});}
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:8192,maxCpuCores:2,storageQuotaMiB:102400,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'VIDEO_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'VIDEO_PREPARATION_REQUESTED'}},
        }});
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'video',timeoutSeconds:1800}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace/video/status', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // Mirrors GET /bookings/:bookingId/workspace/ai/status above, scoped to
    // the Video surface - kept as its own parallel route for the same reason.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'video' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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

  app.post('/bookings/:bookingId/workspace/video/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'video' } } },
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

  app.post('/bookings/:bookingId/workspace/audio', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'audio'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'audio_workspace_incompatible'});}
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:4096,maxCpuCores:2,storageQuotaMiB:40960,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'AUDIO_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'AUDIO_PREPARATION_REQUESTED'}},
        }});
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'audio',timeoutSeconds:1800}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace/audio/status', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // Mirrors GET /bookings/:bookingId/workspace/video/status above, scoped
    // to the Audio surface - kept as its own parallel route for the same reason.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'audio' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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

  app.post('/bookings/:bookingId/workspace/audio/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'audio' } } },
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

  app.post('/bookings/:bookingId/workspace/api', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'api'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'api_workspace_incompatible'});}
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:4096,maxCpuCores:2,storageQuotaMiB:10240,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'API_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'API_PREPARATION_REQUESTED'}},
        }});
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'api',timeoutSeconds:1800}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace/api/status', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // Mirrors GET /bookings/:bookingId/workspace/audio/status above, scoped
    // to the API surface - kept as its own parallel route for the same reason.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'api' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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

  app.post('/bookings/:bookingId/workspace/api/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'api' } } },
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

  app.post('/bookings/:bookingId/workspace/mobile', async (request, reply) => {
    const session=await requireSession(request,reply,redis); if(!session)return;
    const bookingId=String((request.params as {bookingId?:string}).bookingId||'');
    const booking=await db.booking.findFirst({where:{id:bookingId,buyerId:session.userId,status:{in:activeBookings}},include:{listing:{select:{machineId:true}}}});
    if(!booking)return reply.code(409).send({error:'funded_booking_required'});
    let machineWorkspace;
    try { machineWorkspace=await ensureCompatibleMachineWorkspace(db,booking.listing.machineId,'mobile'); }
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'mobile_workspace_incompatible'});}
    const existing=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true}});
    if(existing)return existing;
    try{
      return await db.$transaction(async tx=>{
        const created=await tx.workspaceSession.create({data:{
          bookingId,renterId:session.userId,machineId:booking.listing.machineId,machineWorkspaceId:machineWorkspace.id,
          status:WorkspaceSessionStatus.PREPARING,isolationType:'DOCKER',
          resourceLimits:{maxRamMiB:6144,maxCpuCores:2,storageQuotaMiB:61440,networkAccess:'RESTRICTED',autoStopMinutes:60},
          connectionType:'GPUBNB_GATEWAY',preparationProgress:5,preparationStep:'MOBILE_REQUESTED',
          preparationRequestedAt:new Date(),readyDeadlineAt:new Date(Math.max(Date.now(),booking.startsAt.getTime()-120_000)),expiresAt:booking.endsAt,
          events:{create:{actorType:'RENTER',actorId:session.userId,action:'MOBILE_PREPARATION_REQUESTED'}},
        }});
        // Larger budget than Developer's default: a real Android SDK build
        // (Gradle daemon + AGP + build-tools/AAPT2/D8) needs more headroom -
        // see workspace_gateway.py's "mobile" launch branch (6g/2cpu).
        const job=await tx.job.create({data:{bookingId,renterId:session.userId,machineId:booking.listing.machineId,type:JobType.WORKSPACE_PREPARE,parameters:{workspaceSlug:'mobile',timeoutSeconds:1800}}});
        return tx.workspaceSession.update({where:{id:created.id},data:{jobId:job.id,preparationAttempts:{increment:1}},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      });
    }catch(error){
      const raced=await db.workspaceSession.findFirst({where:{bookingId,renterId:session.userId,machineWorkspaceId:machineWorkspace.id},select:{id:true,status:true,preparationProgress:true,preparationStep:true}});
      if(raced)return raced;
      throw error;
    }
  });

  app.get('/bookings/:bookingId/workspace/mobile/status', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    // Mirrors GET /bookings/:bookingId/workspace/api/status above, scoped to
    // the Mobile surface - kept as its own parallel route for the same reason.
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'mobile' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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

  app.post('/bookings/:bookingId/workspace/mobile/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug: 'mobile' } } },
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
    const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, connection.ready);
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
