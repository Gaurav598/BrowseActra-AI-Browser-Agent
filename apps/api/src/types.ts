export type JobStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export interface JobInput {
  instruction: string;
  url: string;
  outputSchema?: OutputSchema;
}

export interface OutputSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean"; description?: string }>;
  required?: string[];
  additionalProperties?: false;
  description?: string;
}

export interface Job extends JobInput {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown | null;
  error: string | null;
  attempt: number;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  at: string;
  data: unknown;
}

export interface ActionReceiptInput {
  actionId: string;
  status: "verified" | "rejected" | "indeterminate";
  precondition?: unknown;
  postcondition?: unknown;
  metadata?: unknown;
}

export interface ActionReceipt extends ActionReceiptInput {
  id: number;
  jobId: string;
  at: string;
}

export interface JobExecutionContext {
  signal: AbortSignal;
  recordEvent(type: string, data?: unknown): void;
  recordReceipt(receipt: ActionReceiptInput): void;
}

export interface JobExecutor {
  execute(job: Job, context: JobExecutionContext): Promise<unknown>;
}
