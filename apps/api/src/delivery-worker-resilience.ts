// Restart/backoff policy for the Delivery Worker, factored out so it can be
// unit-tested without a real DB/Redis connection.
//
// Two distinct layers, deliberately not merged into one infinite same-process
// retry loop:
//
//   1. Startup connection (connectWithRetry): retried in-process with bounded
//      exponential backoff + jitter. Safe to retry indefinitely-ish here —
//      no application state exists yet for a retry to corrupt.
//
//   2. The running poll loop (FailureTracker, used by delivery-worker.ts's
//      main loop): each failed iteration is retried in-process too, up to
//      MAX_CONSECUTIVE_FAILURES_BEFORE_EXIT. Beyond that bound the worker
//      deliberately exits (process.exitCode = 1) rather than keep looping on
//      Redis/DB connections that may be in an unknown state after a sustained
//      outage — Render (this worker is declared with `type: worker` in
//      render.yaml) then restarts the container with a brand-new process and
//      fresh connections. That boundary — bounded in-process retry vs. a
//      full process restart handed to the platform — is what keeps a
//      corrupted in-memory/connection state from being retried forever
//      inside the same process.
export const RESILIENCE_DEFAULTS = {
  backoffBaseMs: 250,
  backoffMaxMs: 30_000,
  maxConsecutiveFailuresBeforeExit: 20,
  stableResetSuccesses: 10,
} as const;

export function backoffWithJitterMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
  base: number = RESILIENCE_DEFAULTS.backoffBaseMs,
  max: number = RESILIENCE_DEFAULTS.backoffMaxMs,
): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const capped = Math.min(max, base * 2 ** exponent);
  const half = capped / 2;
  return Math.floor(half + random() * half);
}

export type ResilienceDecision =
  | { action: 'retry'; delayMs: number }
  | { action: 'give_up' };

export class FailureTracker {
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;

  constructor(
    private readonly maxConsecutiveFailuresBeforeExit: number = RESILIENCE_DEFAULTS.maxConsecutiveFailuresBeforeExit,
    private readonly stableResetSuccesses: number = RESILIENCE_DEFAULTS.stableResetSuccesses,
    private readonly random: () => number = Math.random,
  ) {}

  recordSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= this.stableResetSuccesses) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  recordFailure(): ResilienceDecision {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailuresBeforeExit) {
      return { action: 'give_up' };
    }
    return { action: 'retry', delayMs: backoffWithJitterMs(this.consecutiveFailures, this.random) };
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }
}

export async function interruptibleSleep(
  ms: number,
  isStopping: () => boolean,
  stepMs = 100,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!isStopping() && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(stepMs, remaining))));
  }
}

export async function connectWithRetry(
  connect: () => Promise<void>,
  isStopping: () => boolean,
  log: (event: Record<string, unknown>) => void,
  random: () => number = Math.random,
): Promise<'connected' | 'stopped'> {
  let attempt = 0;
  while (!isStopping()) {
    try {
      await connect();
      return 'connected';
    } catch (error) {
      attempt += 1;
      log({
        level: 'error',
        message: 'delivery_worker_connect_failed',
        attempt,
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
      });
      await interruptibleSleep(backoffWithJitterMs(attempt, random), isStopping);
    }
  }
  return 'stopped';
}
