import { invariant } from "../../core/src/errors.mjs";

const MAX_MEMORY_BUCKETS = 4_096;

// This fallback is per-process and bounded. Production deployments should use
// a shared rate limiter that enforces quotas across independent workers.
export function createMemoryFixedWindowRateLimiter({
  limit = 30,
  windowMs = 60_000,
  maxBuckets = MAX_MEMORY_BUCKETS,
  now = () => Date.now()
} = {}) {
  invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000, "RATE_LIMIT_CONFIG", "invalid rate limit");
  invariant(Number.isSafeInteger(windowMs) && windowMs >= 1_000, "RATE_WINDOW_CONFIG", "invalid rate window");
  invariant(Number.isSafeInteger(maxBuckets) && maxBuckets >= 1 && maxBuckets <= MAX_MEMORY_BUCKETS, "RATE_BUCKET_CONFIG", "invalid bucket cap");
  invariant(typeof now === "function", "RATE_CLOCK_CONFIG", "invalid rate clock");

  // Insertion order tracks expiration order for a non-decreasing clock: every
  // new fixed window expires at now + windowMs. This makes expired-bucket
  // reclamation proportional to the number actually removed, not the cap.
  const buckets = new Map();
  let lastNow = -1;

  return Object.freeze({
    async consume(key) {
      invariant(typeof key === "string" && key.length > 0 && key.length <= 512, "RATE_KEY", "invalid rate key");
      const current = now();
      invariant(Number.isSafeInteger(current) && current >= 0, "RATE_CLOCK", "invalid rate clock result");
      invariant(current >= lastNow, "RATE_CLOCK_ROLLBACK", "rate clock moved backward");
      invariant(Number.isSafeInteger(current + windowMs), "RATE_CLOCK_RANGE", "rate window exceeds safe integer range");
      lastNow = current;

      const bucket = buckets.get(key);
      if (bucket && current < bucket.resetAt) {
        if (bucket.count >= limit) return { allowed: false, remaining: 0 };
        bucket.count++;
        return { allowed: true, remaining: limit - bucket.count };
      }
      if (bucket) buckets.delete(key);

      // Do not evict live buckets to make space: that would reset another
      // client's quota and enable an attacker to force unlimited requests.
      if (buckets.size >= maxBuckets) {
        for (const [id, value] of buckets) {
          if (current < value.resetAt) break;
          buckets.delete(id);
          if (buckets.size < maxBuckets) break;
        }
      }
      if (buckets.size >= maxBuckets) return { allowed: false, remaining: 0 };

      buckets.set(key, { count: 1, resetAt: current + windowMs });
      return { allowed: true, remaining: limit - 1 };
    }
  });
}
