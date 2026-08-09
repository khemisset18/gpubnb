export type WorkspaceAccessPolicyInput={
  authenticatedUserId:string;
  renterId:string;
  bookingStatus:string;
  sessionStatus:string;
  expiresAt:Date;
  now?:Date;
  machineConnectivity:string;
  machineOperational:string;
  moderationStatus:string;
  lastHeartbeatAt:Date|null;
  heartbeatMaxAgeSeconds:number;
};

export type WorkspaceAccessPolicyResult={allowed:true}|{allowed:false;code:string};

const ACTIVE_BOOKINGS=new Set(['FUNDED','STARTING','ACTIVE']);
const OPENABLE_SESSIONS=new Set(['READY','RUNNING']);

/** Pure fail-closed policy used before minting any interactive access grant. */
export function evaluateWorkspaceAccess(input:WorkspaceAccessPolicyInput):WorkspaceAccessPolicyResult{
  const now=input.now??new Date();
  if(input.authenticatedUserId!==input.renterId)return {allowed:false,code:'NOT_RENTER'};
  if(!ACTIVE_BOOKINGS.has(input.bookingStatus))return {allowed:false,code:'BOOKING_NOT_ACTIVE'};
  if(!OPENABLE_SESSIONS.has(input.sessionStatus))return {allowed:false,code:'WORKSPACE_NOT_READY'};
  if(input.expiresAt.getTime()<=now.getTime())return {allowed:false,code:'SESSION_EXPIRED'};
  if(input.machineConnectivity!=='ONLINE')return {allowed:false,code:'MACHINE_OFFLINE'};
  if(input.machineOperational==='QUARANTINED'||input.machineOperational==='UNAVAILABLE'||input.moderationStatus!=='CLEAR')return {allowed:false,code:'MACHINE_BLOCKED'};
  if(!input.lastHeartbeatAt)return {allowed:false,code:'HEARTBEAT_MISSING'};
  const heartbeatAgeMs=now.getTime()-input.lastHeartbeatAt.getTime();
  if(heartbeatAgeMs<0||heartbeatAgeMs>input.heartbeatMaxAgeSeconds*1000)return {allowed:false,code:'HEARTBEAT_STALE'};
  return {allowed:true};
}
