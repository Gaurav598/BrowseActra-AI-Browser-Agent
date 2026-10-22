import { randomUUID } from "node:crypto";

export type VerificationStatus = "verified" | "rejected" | "indeterminate";

/** Evidence is deliberately small: never persist a full DOM or screenshot by default. */
export interface Observation {
  url: string;
  title?: string;
  text?: string;
  fields?: Record<string, string>;
}

export type Condition =
  | { kind: "url"; equals: string }
  | { kind: "text"; includes: string }
  | { kind: "field"; selector: string; equals: string }
  | { kind: "all"; conditions: Condition[] };

export interface ActionReceipt {
  id: string;
  action: string;
  status: VerificationStatus;
  startedAt: string;
  finishedAt: string;
  precondition?: Condition;
  postcondition?: Condition;
  before: Observation;
  after?: Observation;
  reason: string;
}

const SECRET_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)/gi;
const SECRET_FIELD = /pass(?:word)?|secret|token|api[_-]?key|authorization|cookie/i;
const MAX_TEXT = 512;

function scrub(value: string): string {
  return value.slice(0, MAX_TEXT).replace(SECRET_PATTERN, "[REDACTED]");
}

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return scrub(url.toString());
  } catch {
    return scrub(value);
  }
}

export function redactObservation(observation: Observation): Observation {
  return {
    url: scrubUrl(observation.url),
    title: observation.title === undefined ? undefined : scrub(observation.title),
    text: observation.text === undefined ? undefined : scrub(observation.text),
    fields:
      observation.fields === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(observation.fields)
              .slice(0, 20)
              .map(([key, value]) => [
                scrub(key),
                SECRET_FIELD.test(key) ? "[REDACTED]" : scrub(value),
              ]),
          ),
  };
}

function redactCondition(condition: Condition | undefined): Condition | undefined {
  if (!condition) return undefined;
  switch (condition.kind) {
    case "url":
      return { kind: "url", equals: scrubUrl(condition.equals) };
    case "text":
      return { kind: "text", includes: scrub(condition.includes) };
    case "field":
      return {
        kind: "field",
        selector: scrub(condition.selector),
        equals: SECRET_FIELD.test(condition.selector) ? "[REDACTED]" : scrub(condition.equals),
      };
    case "all":
      return {
        kind: "all",
        conditions: condition.conditions.map((item) => redactCondition(item)!),
      };
  }
}

export function checkCondition(
  observation: Observation,
  condition: Condition,
): boolean | undefined {
  switch (condition.kind) {
    case "url":
      return observation.url === condition.equals;
    case "text":
      return observation.text === undefined
        ? undefined
        : observation.text.includes(condition.includes);
    case "field":
      return observation.fields?.[condition.selector] === undefined
        ? undefined
        : observation.fields[condition.selector] === condition.equals;
    case "all": {
      if (condition.conditions.length === 0) return undefined;
      const results = condition.conditions.map((item) => checkCondition(observation, item));
      if (results.includes(false)) return false;
      if (results.includes(undefined)) return undefined;
      return true;
    }
  }
}

export function createReceipt(input: {
  action: string;
  before: Observation;
  after?: Observation;
  precondition?: Condition;
  postcondition?: Condition;
  executionError?: unknown;
  id?: string;
  startedAt?: string;
}): ActionReceipt {
  const startedAt = input.startedAt ?? new Date().toISOString();
  let status: VerificationStatus = "indeterminate";
  let reason = "No independently checkable postcondition was supplied";
  const pre = input.precondition ? checkCondition(input.before, input.precondition) : true;
  if (pre === false) {
    status = "rejected";
    reason = "Precondition did not hold";
  } else if (pre === undefined) {
    reason = "Precondition could not be observed";
  } else if (input.executionError !== undefined) {
    reason = "Execution failed; browser-side completion is uncertain";
  } else if (input.postcondition && input.after) {
    const post = checkCondition(input.after, input.postcondition);
    status = post === true ? "verified" : post === false ? "rejected" : "indeterminate";
    reason =
      post === true
        ? "Postcondition observed"
        : post === false
          ? "Postcondition did not hold"
          : "Postcondition could not be observed";
  }
  return {
    id: input.id ?? randomUUID(),
    action: scrub(input.action),
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    precondition: redactCondition(input.precondition),
    postcondition: redactCondition(input.postcondition),
    before: redactObservation(input.before),
    after: input.after && redactObservation(input.after),
    reason,
  };
}
