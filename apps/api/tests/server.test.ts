import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../src/server.js";
import type { JobExecutor } from "../src/types.js";

const services: ReturnType<typeof createApiServer>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

async function start(
  executor: JobExecutor,
  overrides: Partial<Parameters<typeof createApiServer>[0]> = {},
) {
  const service = createApiServer({
    databasePath: ":memory:",
    port: 0,
    executor,
    pollMs: 10,
    allowedHosts: ["127.0.0.1"],
    ...overrides,
  });
  services.push(service);
  return { service, ...(await service.listen()) };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/api/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("BrowseActra API", () => {
  it("runs a job, persists receipts/events, and serves the same-origin UI", async () => {
    const executor: JobExecutor = {
      async execute(_job, context) {
        context.recordEvent("observed", { title: "Example" });
        context.recordReceipt({
          actionId: "read-title",
          status: "verified",
          postcondition: { title: "Example" },
        });
        return { title: "Example" };
      },
    };
    const { url } = await start(executor);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/ready`)).status).toBe(200);
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(`${url}/app.js`)).status).toBe(200);
    expect((await fetch(`${url}/style.css`)).status).toBe(200);
    const response = await post(url, { instruction: "Read title", url: "http://127.0.0.1:8080/" });
    expect(response.status).toBe(202);
    const { job } = await response.json();
    await vi.waitFor(async () => {
      const detail = await (await fetch(`${url}/api/v1/jobs/${job.id}`)).json();
      expect(detail.job.status).toBe("completed");
      expect(detail.job.result).toEqual({ title: "Example" });
    });
    const list = await (await fetch(`${url}/api/v1/jobs`)).json();
    expect(list.jobs).toHaveLength(1);
    const events = await (await fetch(`${url}/api/v1/jobs/${job.id}/events`)).json();
    expect(events.events.map((event: { type: string }) => event.type)).toEqual([
      "queued",
      "running",
      "observed",
      "receipt",
      "completed",
    ]);
    const receipts = await (await fetch(`${url}/api/v1/jobs/${job.id}/receipts`)).json();
    expect(receipts.receipts[0].status).toBe("verified");
  });

  it("enforces idempotency, validation, origin policy, and bearer authentication", async () => {
    const { url } = await start(
      { execute: async () => ({ ok: true }) },
      { apiKey: "long-test-key-for-authentication", rateLimitPerMinute: 100 },
    );
    const input = { instruction: "Read title", url: "http://127.0.0.1:8080/" };
    expect((await post(url, input)).status).toBe(401);
    const auth = {
      authorization: "Bearer long-test-key-for-authentication",
      "idempotency-key": "same-request",
    };
    const first = await post(url, input, auth);
    expect(first.status).toBe(202);
    const id = (await first.json()).job.id;
    const repeated = await post(url, input, auth);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).job.id).toBe(id);
    expect((await post(url, { ...input, instruction: "Different" }, auth)).status).toBe(409);
    expect((await post(url, { instruction: "", url: input.url }, auth)).status).toBe(400);
    expect((await post(url, { instruction: "Read", url: "file:///etc/passwd" }, auth)).status).toBe(
      400,
    );
    expect(
      (
        await post(
          url,
          {
            ...input,
            outputSchema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
          { authorization: auth.authorization },
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await post(
          url,
          { ...input, outputSchema: { type: "object", properties: { title: { $ref: "#/x" } } } },
          { authorization: auth.authorization },
        )
      ).status,
    ).toBe(400);
    expect((await post(url, input, { ...auth, origin: "https://evil.example" })).status).toBe(403);
  });

  it("propagates cancellation and records an uncertain outcome", async () => {
    const { url } = await start({
      execute: async (_job, context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        }),
    });
    const response = await post(url, {
      instruction: "Wait forever",
      url: "http://127.0.0.1:8080/",
    });
    const id = (await response.json()).job.id;
    await vi.waitFor(async () => {
      const detail = await (await fetch(`${url}/api/v1/jobs/${id}`)).json();
      expect(detail.job.status).toBe("running");
    });
    const cancel = await fetch(`${url}/api/v1/jobs/${id}/cancel`, { method: "POST" });
    expect((await cancel.json()).job.status).toBe("cancel_requested");
    await vi.waitFor(async () => {
      const detail = await (await fetch(`${url}/api/v1/jobs/${id}`)).json();
      expect(detail.job.status).toBe("indeterminate");
    });
  });

  it("requires authentication and a target allowlist for non-loopback binding", () => {
    const executor: JobExecutor = { execute: async () => null };
    expect(() => createApiServer({ databasePath: ":memory:", host: "0.0.0.0", executor })).toThrow(
      /API key/,
    );
    expect(() =>
      createApiServer({
        databasePath: ":memory:",
        host: "0.0.0.0",
        apiKey: "a".repeat(24),
        executor,
      }),
    ).toThrow(/allowlist/);
  });

  it("denies all browser targets until an operator explicitly allowlists them", async () => {
    const { url } = await start({ execute: async () => null }, { allowedHosts: [] });
    const privateResponse = await post(url, {
      instruction: "Read title",
      url: "http://127.0.0.1:8080/",
    });
    expect(privateResponse.status).toBe(403);
    const publicResponse = await post(url, {
      instruction: "Read title",
      url: "https://example.com/",
    });
    expect(publicResponse.status).toBe(403);
  });

  it("classifies safe failures separately and bounds concurrent execution", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const { url } = await start(
      {
        execute: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => release.push(resolve));
          active--;
          throw Object.assign(new Error("Invalid model output"), { outcome: "failed" });
        },
      },
      { maxConcurrent: 1 },
    );
    const input = { instruction: "Read title", url: "http://127.0.0.1:8080/" };
    const ids = await Promise.all(
      [0, 1].map(async () => (await (await post(url, input)).json()).job.id as string),
    );
    await vi.waitFor(() => expect(release).toHaveLength(1));
    expect(peak).toBe(1);
    release.shift()!();
    await vi.waitFor(() => expect(release).toHaveLength(1));
    release.shift()!();
    await vi.waitFor(async () => {
      for (const id of ids) {
        const detail = await (await fetch(`${url}/api/v1/jobs/${id}`)).json();
        expect(detail.job.status).toBe("failed");
      }
    });
    expect(peak).toBe(1);
  });

  it("rate limits API requests without blocking health checks", async () => {
    const { url } = await start({ execute: async () => null }, { rateLimitPerMinute: 2 });
    expect((await fetch(`${url}/api/v1/jobs`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/jobs`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/jobs`)).status).toBe(429);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
