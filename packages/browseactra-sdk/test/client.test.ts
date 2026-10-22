import { describe, expect, it, vi } from "vitest";
import { BrowseActraApiError, BrowseActraClient } from "../src/index.js";

describe("BrowseActraClient", () => {
  it("sends a typed job request and authentication", async () => {
    const request = vi.fn(
      async (_url: URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ job: { id: "job-1", status: "queued" } }), { status: 202 }),
    );
    const client = new BrowseActraClient({
      baseUrl: "http://127.0.0.1:3000",
      apiKey: "test-key",
      fetch: request as typeof fetch,
    });
    expect(
      (
        await client.jobs.create({
          instruction: "Read title",
          url: "https://example.com",
          idempotencyKey: "same-job",
        })
      ).id,
    ).toBe("job-1");
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ "idempotency-key": "same-job" });
  });

  it("reports API failures", async () => {
    const client = new BrowseActraClient({
      baseUrl: "http://localhost:3000",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "bad input" } }), { status: 400 }),
    });
    await expect(client.jobs.list()).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        message: "bad input",
        name: BrowseActraApiError.name,
      }),
    );
  });

  it("waits for a terminal status", async () => {
    let count = 0;
    const client = new BrowseActraClient({
      baseUrl: "http://localhost:3000",
      fetch: async () =>
        new Response(
          JSON.stringify({ job: { id: "job-1", status: ++count === 1 ? "running" : "completed" } }),
        ),
    });
    expect((await client.jobs.wait("job-1", { intervalMs: 1 })).status).toBe("completed");
  });
});
