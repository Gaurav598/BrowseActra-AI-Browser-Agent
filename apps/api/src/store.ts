import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActionReceipt,
  ActionReceiptInput,
  Job,
  JobEvent,
  JobInput,
  JobStatus,
  OutputSchema,
} from "./types.js";

type RawJob = {
  id: string;
  instruction: string;
  url: string;
  output_schema_json: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error: string | null;
  attempt: number;
  lease_token: number;
};

type RawEvent = { id: number; job_id: string; type: string; at: string; data_json: string };
type RawReceipt = {
  id: number;
  job_id: string;
  action_id: string;
  status: ActionReceiptInput["status"];
  at: string;
  data_json: string;
};

const now = () => new Date().toISOString();
const parseJson = (value: string | null): unknown | null =>
  value === null ? null : JSON.parse(value);

function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (key, item: unknown) => {
    if (/password|secret|token|authorization|cookie|api.?key|credential/i.test(key))
      return "[REDACTED]";
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "string") {
      return item
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(
          /\b(?:sk-[A-Za-z0-9_-]{16,}|bb_live_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
          "[REDACTED]",
        )
        .slice(0, 1_000);
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[REDACTED: circular]";
      seen.add(item);
    }
    return item;
  });
  if (!json) return null;
  if (json.length > 16_384) return "[REDACTED: oversized evidence]";
  return JSON.parse(json) as unknown;
}

function toJob(raw: RawJob): Job {
  return {
    id: raw.id,
    instruction: raw.instruction,
    url: raw.url,
    outputSchema: raw.output_schema_json
      ? (JSON.parse(raw.output_schema_json) as OutputSchema)
      : undefined,
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    result: parseJson(raw.result_json),
    error: raw.error,
    attempt: raw.attempt,
  };
}

export class IdempotencyConflict extends Error {
  constructor() {
    super("Idempotency key was already used for a different job input");
  }
}

export class JobStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (statSync(directory).mode & 0o077) {
        throw new Error("SQLite database directory must be private (mode 0700)");
      }
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        instruction TEXT NOT NULL,
        url TEXT NOT NULL,
        output_schema_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_json TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_token INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_job_idx ON events(job_id, id);
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL,
        status TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        UNIQUE(job_id, action_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private writeEvent(jobId: string, type: string, data: unknown = null): JobEvent {
    const at = now();
    const safeData = redact(data);
    const result = this.db
      .prepare("INSERT INTO events(job_id, type, at, data_json) VALUES (?, ?, ?, ?)")
      .run(jobId, type, at, JSON.stringify(safeData));
    return { id: Number(result.lastInsertRowid), jobId, type, at, data: safeData };
  }

  create(input: JobInput, idempotencyKey?: string): { job: Job; created: boolean } {
    return this.transaction(() => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
          .get(idempotencyKey) as RawJob | undefined;
        if (existing) {
          if (
            existing.instruction !== input.instruction ||
            existing.url !== input.url ||
            existing.output_schema_json !==
              (input.outputSchema ? JSON.stringify(input.outputSchema) : null)
          )
            throw new IdempotencyConflict();
          return { job: toJob(existing), created: false };
        }
      }
      const id = randomUUID();
      const at = now();
      this.db
        .prepare(`INSERT INTO jobs(id, idempotency_key, instruction, url, output_schema_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(
          id,
          idempotencyKey ?? null,
          input.instruction,
          input.url,
          input.outputSchema ? JSON.stringify(input.outputSchema) : null,
          at,
          at,
        );
      this.writeEvent(id, "queued");
      return { job: this.get(id)!, created: true };
    });
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as RawJob | undefined;
    return row ? toJob(row) : null;
  }

  list(limit = 50): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as RawJob[];
    return rows.map(toJob);
  }

  events(jobId: string, after = 0, limit = 500): JobEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(jobId, after, limit) as RawEvent[];
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      type: row.type,
      at: row.at,
      data: JSON.parse(row.data_json),
    }));
  }

  receipts(jobId: string): ActionReceipt[] {
    const rows = this.db
      .prepare("SELECT * FROM receipts WHERE job_id = ? ORDER BY id LIMIT 500")
      .all(jobId) as RawReceipt[];
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      actionId: row.action_id,
      status: row.status,
      at: row.at,
      ...(JSON.parse(row.data_json) as Record<string, unknown>),
    }));
  }

  claim(owner: string, leaseMs: number): { job: Job; token: number } | null {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1")
        .get() as RawJob | undefined;
      if (!row) return null;
      const at = now();
      const token = row.lease_token + 1;
      const result = this.db
        .prepare(`UPDATE jobs SET status='running', updated_at=?, started_at=?, attempt=attempt+1,
        lease_token=?, lease_owner=?, lease_expires_at=? WHERE id=? AND status='queued'`)
        .run(at, at, token, owner, Date.now() + leaseMs, row.id);
      if (result.changes !== 1) return null;
      this.writeEvent(row.id, "running", { attempt: row.attempt + 1 });
      return { job: this.get(row.id)!, token };
    });
  }

  heartbeat(id: string, token: number, owner: string, leaseMs: number): boolean {
    const result = this.db
      .prepare(`UPDATE jobs SET lease_expires_at=? WHERE id=? AND lease_token=? AND lease_owner=?
      AND status IN ('running','cancel_requested') AND lease_expires_at >= ?`)
      .run(Date.now() + leaseMs, id, token, owner, Date.now());
    return result.changes === 1;
  }

  leaseStatus(id: string, token: number, owner: string): "running" | "cancel_requested" | null {
    const row = this.db
      .prepare(`SELECT status FROM jobs WHERE id=? AND lease_token=?
      AND lease_owner=? AND lease_expires_at>=?`)
      .get(id, token, owner, Date.now()) as { status: string } | undefined;
    return row?.status === "running" || row?.status === "cancel_requested" ? row.status : null;
  }

  cancel(id: string): Job | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as RawJob | undefined;
      if (!row) return null;
      if (row.status === "queued" || row.status === "running") {
        const status = row.status === "queued" ? "cancelled" : "cancel_requested";
        const at = now();
        this.db
          .prepare("UPDATE jobs SET status=?, updated_at=?, finished_at=? WHERE id=?")
          .run(status, at, status === "cancelled" ? at : null, id);
        this.writeEvent(id, status);
      }
      return this.get(id);
    });
  }

  appendEvent(id: string, token: number, type: string, data?: unknown): JobEvent | null {
    return this.transaction(() => {
      if (!this.ownsLease(id, token)) return null;
      return this.writeEvent(id, type, data);
    });
  }

  appendReceipt(id: string, token: number, receipt: ActionReceiptInput): ActionReceipt | null {
    return this.transaction(() => {
      if (!this.ownsLease(id, token)) return null;
      const at = now();
      const safe = redact({
        precondition: receipt.precondition,
        postcondition: receipt.postcondition,
        metadata: receipt.metadata,
      }) as Record<string, unknown>;
      const result = this.db
        .prepare(`INSERT INTO receipts(job_id, action_id, status, at, data_json)
        VALUES (?, ?, ?, ?, ?)`)
        .run(id, receipt.actionId, receipt.status, at, JSON.stringify(safe));
      this.writeEvent(id, "receipt", { actionId: receipt.actionId, status: receipt.status });
      return {
        id: Number(result.lastInsertRowid),
        jobId: id,
        actionId: receipt.actionId,
        status: receipt.status,
        at,
        ...safe,
      };
    });
  }

  private ownsLease(id: string, token: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM jobs WHERE id=? AND lease_token=?
      AND status IN ('running','cancel_requested') AND lease_expires_at >= ?`)
      .get(id, token, Date.now());
    return Boolean(row);
  }

  finish(
    id: string,
    token: number,
    status: "completed" | "failed" | "indeterminate",
    result?: unknown,
    error?: string,
  ): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT status FROM jobs WHERE id=? AND lease_token=? AND lease_expires_at >= ?")
        .get(id, token, Date.now()) as { status: JobStatus } | undefined;
      if (!row || (row.status !== "running" && row.status !== "cancel_requested")) return false;
      const finalStatus = row.status === "cancel_requested" ? "indeterminate" : status;
      const at = now();
      const safeError = error === undefined ? null : String(redact(error)).slice(0, 500);
      const safeResult = result === undefined ? null : JSON.stringify(redact(result));
      const update = this.db
        .prepare(`UPDATE jobs SET status=?, updated_at=?, finished_at=?, result_json=?, error=?,
        lease_owner=NULL, lease_expires_at=NULL WHERE id=? AND lease_token=? AND status=?`)
        .run(finalStatus, at, at, safeResult, safeError, id, token, row.status);
      if (update.changes !== 1) return false;
      this.writeEvent(id, finalStatus, safeError ? { error: safeError } : null);
      return true;
    });
  }

  recoverExpired(): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id FROM jobs WHERE status IN ('running','cancel_requested')
        AND lease_expires_at < ?`)
        .all(Date.now()) as { id: string }[];
      for (const row of rows) {
        const at = now();
        this.db
          .prepare(`UPDATE jobs SET status='indeterminate', updated_at=?, finished_at=?,
          error='Worker lease expired before confirming the browser action', lease_owner=NULL, lease_expires_at=NULL,
          lease_token=lease_token+1 WHERE id=?`)
          .run(at, at, row.id);
        this.writeEvent(row.id, "indeterminate", { reason: "lease_expired" });
      }
      return rows.length;
    });
  }
}
