export const DEFAULT_PUBLIC_HEALTH_DELAYS_MS = [
  0,
  1_000,
  2_000,
  3_000,
  5_000,
  8_000,
  10_000,
  10_000,
  10_000,
  10_000
] as const;

export interface HealthProbe {
  attempt: number;
  delayMs: number;
  healthy: boolean;
  elapsedMs: number;
}

export interface WaitForHealthOptions {
  timeoutMs?: number;
  delaysMs?: readonly number[];
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onProbe?: (probe: HealthProbe) => void | Promise<void>;
}

export interface WaitForHealthResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
}

/**
 * Wait for a public endpoint to become reachable without treating the first
 * few edge-routing failures as a fatal local-server failure.
 */
export async function waitForHealth(
  check: () => Promise<boolean>,
  options: WaitForHealthOptions = {}
): Promise<WaitForHealthResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const delaysMs = options.delaysMs ?? DEFAULT_PUBLIC_HEALTH_DELAYS_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const startedAt = now();
  let attempts = 0;

  for (const [index, delayMs] of delaysMs.entries()) {
    const elapsedBeforeAttempt = now() - startedAt;
    if (index > 0 && elapsedBeforeAttempt + delayMs > timeoutMs) break;
    if (index > 0) await sleep(delayMs);
    if (now() - startedAt > timeoutMs) break;

    let healthy = false;
    try {
      healthy = await check();
    } catch {
      healthy = false;
    }
    attempts += 1;
    const probe: HealthProbe = {
      attempt: attempts,
      delayMs,
      healthy,
      elapsedMs: now() - startedAt
    };
    await options.onProbe?.(probe);
    if (healthy) {
      return { ready: true, attempts, elapsedMs: probe.elapsedMs };
    }
  }

  return { ready: false, attempts, elapsedMs: now() - startedAt };
}
