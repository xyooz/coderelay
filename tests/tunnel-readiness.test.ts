import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_HEALTH_DELAYS_MS, waitForHealth } from "../src/tunnel/readiness.js";

describe("public tunnel readiness", () => {
  it("uses the documented exponential-backoff schedule until the endpoint is healthy", async () => {
    const delays: number[] = [];
    let checks = 0;
    const result = await waitForHealth(
      async () => {
        checks += 1;
        return checks === 4;
      },
      {
        delaysMs: [0, 1, 2, 3],
        sleep: async (delayMs) => { delays.push(delayMs); }
      }
    );

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(4);
    expect(delays).toEqual([1, 2, 3]);
  });

  it("returns not-ready after the bounded schedule instead of throwing", async () => {
    const probes: boolean[] = [];
    const result = await waitForHealth(
      async () => false,
      {
        delaysMs: [0, 1, 2],
        sleep: async () => undefined,
        onProbe: (probe) => { probes.push(probe.healthy); }
      }
    );

    expect(result.ready).toBe(false);
    expect(result.attempts).toBe(3);
    expect(probes).toEqual([false, false, false]);
  });

  it("bounds the default retry schedule to roughly one minute", () => {
    expect(Array.from(DEFAULT_PUBLIC_HEALTH_DELAYS_MS).reduce<number>((sum, delay) => sum + delay, 0)).toBe(59_000);
  });
});
