export type GatewayQueueRedis = {
  rpop(key: string): Promise<string | null>;
};

export const GATEWAY_QUEUE_WAIT_MS = 8_000;
export const GATEWAY_QUEUE_POLL_MS = 100;

type WaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export async function waitForGatewayQueueItem(
  redis: GatewayQueueRedis,
  key: string,
  options: WaitOptions = {},
): Promise<string | null> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? GATEWAY_QUEUE_WAIT_MS);
  const pollMs = Math.max(1, options.pollMs ?? GATEWAY_QUEUE_POLL_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;

  while (true) {
    const item = await redis.rpop(key);
    if (item !== null) return item;
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    await sleep(Math.min(pollMs, remaining));
  }
}
