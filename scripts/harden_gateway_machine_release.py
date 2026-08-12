from pathlib import Path

path = Path('apps/api/src/workspace-gateway.ts')
source = path.read_text(encoding='utf-8')
source = source.replace(
    "import { BookingStatus, MachineConnectivity, MachineOperational, ModerationStatus, PaymentStatus, SessionTerminationReason, WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';",
    "import { BookingStatus, JobStatus, MachineConnectivity, MachineOperational, ModerationStatus, PaymentStatus, Prisma, SessionTerminationReason, WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';",
    1,
)
old = """    const neverActivated=row.startedAt===null;const endedAt=new Date();
    await db.$transaction([
      db.workspaceSession.update({where:{id:row.id},data:{status:neverActivated?WorkspaceSessionStatus.TIMED_OUT:WorkspaceSessionStatus.COMPLETED,endedAt,connectionMetadata:{},...(neverActivated?{terminationReason:SessionTerminationReason.TIMEOUT,preparationStep:'INTERACTIVE_CONNECTION_TIMEOUT'}:{}),events:{create:{actorType:'AGENT',actorId:machineId,action:neverActivated?'INTERACTIVE_CONNECTION_NEVER_ESTABLISHED':'GATEWAY_CLEANUP_VERIFIED'}}}}),
      ...(neverActivated?[
        db.booking.updateMany({where:{id:row.bookingId,status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING]}},data:{status:BookingStatus.DEGRADED}}),
        db.payment.updateMany({where:{bookingId:row.bookingId,status:PaymentStatus.ESCROW_FUNDED},data:{status:PaymentStatus.SETTLEMENT_PENDING}}),
      ]:[]),
      db.machine.update({where:{id:machineId},data:{operational:MachineOperational.AVAILABLE}}),
    ]);return {ok:true,activated:!neverActivated};
"""
new = """    const neverActivated=row.startedAt===null;const endedAt=new Date();
    const release=await db.$transaction(async tx=>{
      await tx.workspaceSession.update({where:{id:row.id},data:{status:neverActivated?WorkspaceSessionStatus.TIMED_OUT:WorkspaceSessionStatus.COMPLETED,endedAt,connectionMetadata:{},...(neverActivated?{terminationReason:SessionTerminationReason.TIMEOUT,preparationStep:'INTERACTIVE_CONNECTION_TIMEOUT'}:{}),events:{create:{actorType:'AGENT',actorId:machineId,action:neverActivated?'INTERACTIVE_CONNECTION_NEVER_ESTABLISHED':'GATEWAY_CLEANUP_VERIFIED'}}}});
      if(neverActivated){
        await tx.booking.updateMany({where:{id:row.bookingId,status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING]}},data:{status:BookingStatus.DEGRADED}});
        await tx.payment.updateMany({where:{bookingId:row.bookingId,status:PaymentStatus.ESCROW_FUNDED},data:{status:PaymentStatus.SETTLEMENT_PENDING}});
      }
      const machineUpdate=await tx.machine.updateMany({
        where:{
          id:machineId,
          moderationStatus:ModerationStatus.CLEAR,
          workspaceSessions:{none:{id:{not:row.id},status:{in:[WorkspaceSessionStatus.RESERVED,WorkspaceSessionStatus.PREPARING,WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING,WorkspaceSessionStatus.STOP_REQUESTED,WorkspaceSessionStatus.STOPPING]}}},
          jobs:{none:{status:{in:[JobStatus.ASSIGNED,JobStatus.DOWNLOADING,JobStatus.PREPARING,JobStatus.RUNNING,JobStatus.UPLOADING_RESULTS,JobStatus.CANCEL_REQUESTED]}}},
          listings:{none:{bookings:{some:{id:{not:row.bookingId},status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE,BookingStatus.DEGRADED]}}}}},
        },
        data:{operational:neverActivated?MachineOperational.DEGRADED:MachineOperational.AVAILABLE},
      });
      return machineUpdate.count===1;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    return {ok:true,activated:!neverActivated,machineReleased:release};
"""
if source.count(old) != 1:
    raise RuntimeError(f'gateway release marker count={source.count(old)}')
source = source.replace(old, new, 1)
path.write_text(source, encoding='utf-8', newline='\n')

# Keep the workflow ephemeral.
Path('.github/workflows/harden-gateway-machine-release.yml').unlink(missing_ok=True)
Path('scripts/harden_gateway_machine_release.py').unlink(missing_ok=True)
