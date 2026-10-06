import { invariant } from "../../core/src/errors.mjs";

export function createMemoryFixedWindowRateLimiter({ limit = 30, windowMs = 60_000, now = () => Date.now() } = {}) {
  invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000, "RATE_LIMIT_CONFIG", "invalid rate limit");
  invariant(Number.isSafeInteger(windowMs) && windowMs >= 1_000, "RATE_WINDOW_CONFIG", "invalid rate window");
  const buckets = new Map();

  return Object.freeze({
    async consume(key) {
      invariant(typeof key === "string" && key.length > 0 && key.length <= 512, "RATE_KEY", "invalid rate key");
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: current + windowMs });
        return { allowed: true, remaining: limit - 1 };
      }
      if (bucket.count >= limit) return { allowed: false, remaining: 0 };
      bucket.count++;
      return { allowed: true, remaining: limit - bucket.count };
    }
  });
}
