import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyConflict, JobStore } from "../src/store.js";
import { JobWorker } from "../src/worker.js";

const input = { instruction: "Read the title", url: "http://127.0.0.1:8080/" };
const stores: JobStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): JobStore {
  const store = new JobStore(":memory:");
  stores.push(store);
  return store;
}

describe("durable job store", () => {
  it("deduplicates identical submissions and rejects conflicting keys", () => {
    const store = memoryStore();
    const first = store.create(input, "request-1");
    const second = store.create(input, "request-1");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(store.list()).toHaveLength(1);
    expect(() => store.create({ ...input, instruction: "Different" }, "request-1")).toThrow(
      IdempotencyConflict,
    );
  });

  it("persists queued jobs across store reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "browseactra-api-"));
    dirs.push(dir);
    const path = join(dir, "jobs.sqlite");
    const first = new JobStore(path);
    expect(statSync(path).mode & 0o077).toBe(0);
    const job = first.create(input).job;
    first.close();
    const reopened = new JobStore(path);
    stores.push(reopened);
    expect(reopened.get(job.id)?.status).toBe("queued");
    expect(reopened.events(job.id).map((event) => event.type)).toEqual(["queued"]);
  });

  it("fences stale workers and marks expired leases indeterminate without replay", async () => {
    const store = memoryStore();
    const job = store.create(input).job;
    const claim = store.claim("worker-a", 100)!;
    expect(claim.job.id).toBe(job.id);
    expect(store.heartbeat(job.id, claim.token + 1, "worker-a", 100)).toBe(false);
    expect(store.appendEvent(job.id, claim.token + 1, "unsafe", {})).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(store.recoverExpired()).toBe(1);
    expect(store.get(job.id)?.status).toBe("indeterminate");
    expect(store.finish(job.id, claim.token, "completed", { ok: true })).toBe(false);
    expect(store.claim("worker-b", 100)).toBeNull();
  });

  it("records bounded, redacted receipts and events under the active lease", () => {
    const store = memoryStore();
    const job = store.create(input).job;
    const claim = store.claim("worker-a", 1_000)!;
    store.appendReceipt(job.id, claim.token, {
      actionId: "click-1",
      status: "verified",
      metadata: { password: "hidden", selector: "#submit", authorization: "Bearer fake" },
    });
    const receipt = store.receipts(job.id)[0];
    expect(receipt.status).toBe("verified");
    expect(receipt.metadata).toEqual({
      password: "[REDACTED]",
      selector: "#submit",
      authorization: "[REDACTED]",
    });
    expect(store.events(job.id).map((event) => event.type)).toEqual([
      "queued",
      "running",
      "receipt",
    ]);
    expect(store.finish(job.id, claim.token, "completed", { title: "Example" })).toBe(true);
    expect(store.get(job.id)?.result).toEqual({ title: "Example" });
  });

  it("does not claim cancelled queued jobs and treats active cancellation as uncertain", () => {
    const store = memoryStore();
    const queued = store.create(input).job;
    expect(store.cancel(queued.id)?.status).toBe("cancelled");
    expect(store.claim("worker", 1_000)).toBeNull();
    const running = store.create(input).job;
    const claim = store.claim("worker", 1_000)!;
    expect(store.cancel(running.id)?.status).toBe("cancel_requested");
    expect(store.finish(running.id, claim.token, "completed", { ok: true })).toBe(true);
    expect(store.get(running.id)?.status).toBe("indeterminate");
  });

  it("propagates cancellation from another store instance to the owning worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browseactra-cancel-"));
    dirs.push(dir);
    const path = join(dir, "jobs.sqlite");
    const ownerStore = new JobStore(path);
    const requesterStore = new JobStore(path);
    stores.push(ownerStore, requesterStore);
    const job = ownerStore.create(input).job;
    let aborted = false;
    const worker = new JobWorker(
      ownerStore,
      {
        execute: async (_job, context) =>
          new Promise((_, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(context.signal.reason);
              },
              { once: true },
            );
          }),
      },
      { pollMs: 10, leaseMs: 300, abortGraceMs: 20 },
    );
    worker.start();
    try {
      await vi.waitFor(() => expect(ownerStore.get(job.id)?.status).toBe("running"));
      expect(requesterStore.cancel(job.id)?.status).toBe("cancel_requested");
      await vi.waitFor(() => expect(aborted).toBe(true));
      await vi.waitFor(() => expect(ownerStore.get(job.id)?.status).toBe("indeterminate"));
    } finally {
      await worker.close();
    }
  });
});
