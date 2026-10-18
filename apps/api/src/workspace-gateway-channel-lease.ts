/** Revalidate an already-open native channel; an upgrade is not a permanent grant. */
export function createGatewayChannelLeaseGuard({
  sessionId, userId, readBrowser, readWorkspace, now = Date.now, cacheMs = 1000, timeoutMs = 5000,
}: {
  sessionId: string; userId: string;
  readBrowser: () => Promise<string | null>;
  readWorkspace: () => Promise<{ renterId: string; expiresAt: Date } | null>;
  now?: () => number; cacheMs?: number; timeoutMs?: number;
}) {
  let checkedAt: number | null = null;
  let allowed = false;
  let validUntil = 0;
  let pending: Promise<boolean> | null = null;
  return async function authorized(): Promise<boolean> {
    const time = now();
    if (!Number.isFinite(time)) return false;
    if (checkedAt !== null && time >= checkedAt && time - checkedAt < cacheMs && time < validUntil) return allowed;
    if (pending) return pending;
    pending = (async () => {
      allowed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [raw, row] = await Promise.race([
          Promise.all([readBrowser(), readWorkspace()]),
          new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('channel_authorization_timeout')),timeoutMs);}),
        ]);
        const browser: unknown = raw ? JSON.parse(raw) : null;
        const current = now();
        const expiresAt = row?.expiresAt.getTime() ?? NaN;
        allowed = typeof browser === 'object' && browser !== null
          && 'sessionId' in browser && browser.sessionId === sessionId
          && 'userId' in browser && browser.userId === userId
          && row?.renterId === userId && Number.isFinite(expiresAt)
          && Number.isFinite(current) && current >= time && expiresAt > current;
        checkedAt = current;
        validUntil = allowed ? Math.min(current + cacheMs, expiresAt) : current;
      } catch { allowed = false; checkedAt = null; }
      finally { if(timer!==undefined)clearTimeout(timer); }
      return allowed;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
