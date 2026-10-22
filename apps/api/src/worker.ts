import { randomUUID } from "node:crypto";
import type { JobExecutor } from "./types.js";
import { JobStore } from "./store.js";

export interface WorkerOptions {
  maxConcurrent?: number;
  pollMs?: number;
  leaseMs?: number;
  executionTimeoutMs?: number;
  abortGraceMs?: number;
}

type ActiveJob = {
  token: number;
  controller: AbortController;
  done: Promise<void>;
  timers: Set<NodeJS.Timeout>;
  stopTimers: () => void;
};

export class JobWorker {
  readonly owner = randomUUID();
  private readonly active = new Map<string, ActiveJob>();
  private readonly maxConcurrent: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly executionTimeoutMs: number;
  private readonly abortGraceMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private pumping = false;

  constructor(
    private readonly store: JobStore,
    private readonly executor: JobExecutor,
    options: WorkerOptions = {},
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.pollMs = options.pollMs ?? 250;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.executionTimeoutMs = options.executionTimeoutMs ?? 120_000;
    this.abortGraceMs = options.abortGraceMs ?? 2_000;
    if (
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 32
    ) {
      throw new Error("maxConcurrent must be between 1 and 32");
    }
    if (
      this.leaseMs < 100 ||
      this.pollMs < 10 ||
      this.executionTimeoutMs < 100 ||
      this.abortGraceMs < 0
    ) {
      throw new Error("Invalid worker timing options");
    }
  }

  start(): void {
    if (this.pollTimer) return;
    this.store.recoverExpired();
    this.pollTimer = setInterval(() => this.pump(), this.pollMs);
    this.pollTimer.unref();
    this.pump();
  }

  wake(): void {
    this.pump();
  }

  cancel(jobId: string): void {
    const active = this.active.get(jobId);
    if (!active || active.controller.signal.aborted) return;
    active.controller.abort(new Error("Job cancellation requested"));
    const timer = setTimeout(() => {
      if (!this.closing && this.active.get(jobId) === active) {
        active.stopTimers();
        this.store.finish(
          jobId,
          active.token,
          "indeterminate",
          undefined,
          "Cancellation was not acknowledged by the executor",
        );
      }
    }, this.abortGraceMs);
    timer.unref();
    active.timers.add(timer);
  }

  private pump(): void {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      this.store.recoverExpired();
      while (this.active.size < this.maxConcurrent) {
        const claim = this.store.claim(this.owner, this.leaseMs);
        if (!claim) break;
        this.run(claim.job.id, claim.token, claim.job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private run(jobId: string, token: number, job: NonNullable<ReturnType<JobStore["get"]>>): void {
    const controller = new AbortController();
    const timers = new Set<NodeJS.Timeout>();
    const heartbeat = setInterval(
      () => {
        if (!this.store.heartbeat(jobId, token, this.owner, this.leaseMs)) {
          controller.abort(new Error("Worker lease lost"));
        } else if (this.store.leaseStatus(jobId, token, this.owner) === "cancel_requested") {
          this.cancel(jobId);
        }
      },
      Math.max(50, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    timers.add(heartbeat);
    const deadline = setTimeout(() => {
      if (this.closing) return;
      controller.abort(new Error("Job execution deadline exceeded"));
      const grace = setTimeout(() => {
        if (!this.closing)
          this.store.finish(
            jobId,
            token,
            "indeterminate",
            undefined,
            "Execution deadline expired before confirmation",
          );
      }, this.abortGraceMs);
      grace.unref();
      timers.add(grace);
    }, this.executionTimeoutMs);
    deadline.unref();
    timers.add(deadline);
    const stopTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const done = Promise.resolve()
      .then(() =>
        this.executor.execute(job, {
          signal: controller.signal,
          recordEvent: (type, data) => {
            if (typeof type !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(type))
              throw new Error("Invalid event type");
            if (!this.store.appendEvent(jobId, token, type, data))
              throw new Error("Worker lease lost");
          },
          recordReceipt: (receipt) => {
            if (
              !receipt ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.actionId) ||
              !["verified", "rejected", "indeterminate"].includes(receipt.status)
            ) {
              throw new Error("Invalid action receipt");
            }
            if (!this.store.appendReceipt(jobId, token, receipt))
              throw new Error("Worker lease lost");
          },
        }),
      )
      .then((result) => {
        if (!this.closing)
          this.store.finish(
            jobId,
            token,
            controller.signal.aborted ? "indeterminate" : "completed",
            result,
          );
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown execution error";
        const outcome =
          !controller.signal.aborted &&
          error &&
          typeof error === "object" &&
          "outcome" in error &&
          error.outcome === "failed"
            ? "failed"
            : "indeterminate";
        if (!this.closing) this.store.finish(jobId, token, outcome, undefined, message);
      })
      .finally(() => {
        stopTimers();
        this.active.delete(jobId);
        this.pump();
      });
    this.active.set(jobId, { token, controller, done, timers, stopTimers });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const [jobId, active] of this.active) {
      active.controller.abort(new Error("Worker shutting down"));
      active.stopTimers();
      this.store.finish(
        jobId,
        active.token,
        "indeterminate",
        undefined,
        "Worker shut down before confirmation",
      );
    }
    await Promise.race([
      Promise.allSettled([...this.active.values()].map((active) => active.done)),
      new Promise<void>((resolve) => setTimeout(resolve, this.abortGraceMs)),
    ]);
  }
}
