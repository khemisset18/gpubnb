/** Revalidate an already-open native channel; an upgrade is not a permanent grant. */
export function createGatewayChannelLeaseGuard({
  sessionId, userId, expectedMachineId, expectedRuntimeBackend, readBrowser, readWorkspace, now = Date.now, cacheMs = 1000, timeoutMs = 5000,
}: {
  sessionId: string; userId: string;
  expectedMachineId?: string; expectedRuntimeBackend?: string;
  readBrowser: () => Promise<string | null>;
  readWorkspace: () => Promise<{ renterId: string; expiresAt: Date; machineId?: string; runtimeBackend?: string } | null>;
  now?: () => number; cacheMs?: number; timeoutMs?: number;
}) {
  let checkedAt: number | null = null;
  let allowed = false;
  let validUntil = 0;
  let pending: Promise<boolean> | null = null;
  let revision = 0;
  let invalidated = false;
  async function authorized(): Promise<boolean> {
    const time = now();
    if (invalidated || !Number.isFinite(time)) return false;
    if (checkedAt !== null && time >= checkedAt && time - checkedAt < cacheMs && time < validUntil) return allowed;
    // Zero-cache callers need reads begun for their own operation. Sharing an
    // older read would let a post-revocation frame inherit a stale positive.
    if (cacheMs > 0 && pending) return pending;
    const startedRevision = revision;
    const check = (async () => {
      let result = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [raw, row] = await Promise.race([
          Promise.all([readBrowser(), readWorkspace()]),
          new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('channel_authorization_timeout')),timeoutMs);}),
        ]);
        const browser: unknown = raw ? JSON.parse(raw) : null;
        const current = now();
        const expiresAt = row?.expiresAt.getTime() ?? NaN;
        result = !invalidated && revision === startedRevision
          && typeof browser === 'object' && browser !== null
          && 'sessionId' in browser && browser.sessionId === sessionId
          && 'userId' in browser && browser.userId === userId
          && row?.renterId === userId
          // A native channel is bound to the machine and runtime selected at upgrade.
          // Do not relay to a stale machine if a session is reassigned in the DB.
          && (expectedMachineId === undefined || row?.machineId === expectedMachineId)
          && (expectedRuntimeBackend === undefined || row?.runtimeBackend === expectedRuntimeBackend)
          && Number.isFinite(expiresAt)
          && Number.isFinite(current) && current >= time && expiresAt > current;
        if (result) {
          allowed = true;
          checkedAt = current;
          validUntil = Math.min(current + cacheMs, expiresAt);
        }
      } catch { result = false; }
      finally { if(timer!==undefined)clearTimeout(timer); }
      if (!result) {
        invalidated = true; // Denial is terminal: a reconnect needs a new channel.
        revision++; // A known denial fences outstanding positive reads.
        allowed = false;
        checkedAt = null;
      }
      return result;
    })();
    if (cacheMs > 0) pending = check;
    try { return await check; } finally { if (pending === check) pending = null; }
  }
  // Terminal for this channel: no late promise or reconnect may revive it.
  authorized.invalidate = () => { invalidated = true; revision++; allowed = false; checkedAt = null; };
  return authorized;
}
