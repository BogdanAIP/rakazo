import { describe, expect, it, vi } from "vitest";
import { DATABASE_CHECK_TIMEOUT_MS, healthRoutes } from "./health.js";

const app = healthRoutes(() => ({ runtime: "pi", sandbox: "docker", revision: "abc123" }));

describe("health routes", () => {
  it("returns 503 when readiness depends on an unavailable database", async () => {
    let available = false;
    const health = healthRoutes(
      () => ({}),
      async () => {
        if (!available) throw new Error("connection refused");
      },
    );

    const failed = await health.request("/ready");
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({
      ok: false,
      degraded: false,
      database: "unreachable",
    });
    expect((await health.request("/health")).status).toBe(200);

    available = true;
    const recovered = await health.request("/ready");
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ ok: true, degraded: false });
  });

  it("keeps liveness up and readiness down when an existing service is degraded", async () => {
    const health = healthRoutes(() => ({ degraded: true }));
    const response = await health.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
    expect((await health.request("/health")).status).toBe(200);
  });

  it("bounds hung database readiness and shares a single concurrent probe", async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(() => new Promise<never>(() => {}));
      const health = healthRoutes(() => ({}), check);
      const first = health.request("/ready");
      const second = health.request("/ready");
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
      expect((await first).status).toBe(503);
      expect((await second).status).toBe(503);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps public liveness free of deployment details", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves details to direct requests on the API port", async () => {
    const response = await app.request("/internal/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc123",
    });
  });

  it("hides details from requests that came through a reverse proxy", async () => {
    for (const headers of [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
    ]) {
      const response = await app.request("/internal/health", { headers });
      expect(response.status).toBe(404);
    }
  });
});
