export type JobStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export interface Job {
  id: string;
  instruction: string;
  url: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  attempt?: number;
  outputSchema?: unknown;
  result?: unknown;
  error?: string | null;
}

export interface CreateJobRequest {
  instruction: string;
  url: string;
  outputSchema?: unknown;
  idempotencyKey?: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  at: string;
  data: unknown;
}

export interface ActionReceipt {
  id: number;
  jobId: string;
  actionId: string;
  status: "verified" | "rejected" | "indeterminate";
  at: string;
  precondition?: unknown;
  postcondition?: unknown;
  metadata?: unknown;
}

export class BrowseActraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BrowseActraApiError";
  }
}

export class BrowseActraClient {
  readonly jobs: {
    create: (input: CreateJobRequest, signal?: AbortSignal) => Promise<Job>;
    list: (signal?: AbortSignal) => Promise<Job[]>;
    get: (id: string, signal?: AbortSignal) => Promise<Job>;
    cancel: (id: string, signal?: AbortSignal) => Promise<Job>;
    events: (id: string, signal?: AbortSignal) => Promise<JobEvent[]>;
    receipts: (id: string, signal?: AbortSignal) => Promise<ActionReceipt[]>;
    wait: (
      id: string,
      options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
    ) => Promise<Job>;
  };

  constructor(
    private readonly options: { baseUrl: string; apiKey?: string; fetch?: typeof fetch },
  ) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new TypeError("baseUrl must be an HTTP URL");
    this.jobs = {
      create: async ({ idempotencyKey, ...input }, signal) =>
        (await this.request<{ job: Job }>("POST", "/api/v1/jobs", input, signal, idempotencyKey))
          .job,
      list: async (signal) =>
        (await this.request<{ jobs: Job[] }>("GET", "/api/v1/jobs", undefined, signal)).jobs,
      get: async (id, signal) =>
        (
          await this.request<{ job: Job }>(
            "GET",
            `/api/v1/jobs/${encodeURIComponent(id)}`,
            undefined,
            signal,
          )
        ).job,
      cancel: async (id, signal) =>
        (
          await this.request<{ job: Job }>(
            "POST",
            `/api/v1/jobs/${encodeURIComponent(id)}/cancel`,
            undefined,
            signal,
          )
        ).job,
      events: async (id, signal) =>
        (
          await this.request<{ events: JobEvent[] }>(
            "GET",
            `/api/v1/jobs/${encodeURIComponent(id)}/events`,
            undefined,
            signal,
          )
        ).events,
      receipts: async (id, signal) =>
        (
          await this.request<{ receipts: ActionReceipt[] }>(
            "GET",
            `/api/v1/jobs/${encodeURIComponent(id)}/receipts`,
            undefined,
            signal,
          )
        ).receipts,
      wait: (id, options) => this.wait(id, options),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
      const message =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : `HTTP ${response.status}`;
      throw new BrowseActraApiError(response.status, message);
    }
    return payload as T;
  }

  private async wait(
    id: string,
    options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Job> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (true) {
      options.signal?.throwIfAborted();
      const job = await this.jobs.get(id, options.signal);
      if (["completed", "failed", "cancelled", "indeterminate"].includes(job.status)) return job;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for job ${id}`);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, options.intervalMs ?? 250);
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
