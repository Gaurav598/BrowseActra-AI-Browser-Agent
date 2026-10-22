import { createHash, randomUUID } from "node:crypto";
import { parseAgentDecision } from "./provider.js";
import type {
  ActionExecution,
  ActionPolicy,
  AgentActionRecord,
  AgentHooks,
  AgentProvider,
  AgentResult,
  AgentRunOptions,
  BrowserAction,
  BrowserObservation,
  BrowserSession,
  VerificationStatus,
} from "./types.js";

export interface AgentOptions {
  readonly policy?: ActionPolicy;
  readonly hooks?: AgentHooks;
}

/**
 * A bounded observe → decide → authorize → execute → verify loop. Model output
 * is only a proposal; browser observations and trusted policy decide progress.
 */
export class Agent {
  constructor(
    private readonly session: BrowserSession,
    private readonly provider: AgentProvider,
    private readonly options: AgentOptions = {},
  ) {}

  async run(input: AgentRunOptions): Promise<AgentResult> {
    if (!input.goal.trim() || input.goal.length > 2_000)
      throw new Error("Goal must contain 1 to 2000 characters");
    const maxSteps = input.maxSteps ?? 12;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50)
      throw new Error("maxSteps must be between 1 and 50");
    const actions: AgentActionRecord[] = [];
    const onAbort = (): void => {
      void this.session.close();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (input.signal?.aborted)
        return result("cancelled", actions, null, undefined, "Task cancelled");
      if (input.initialUrl) {
        const first = await this.perform({ type: "navigate", url: input.initialUrl }, actions);
        if (first !== "verified")
          return result(first === "rejected" ? "blocked" : "indeterminate", actions, null);
      }

      for (let step = 0; step < maxSteps; step++) {
        if (input.signal?.aborted)
          return result("cancelled", actions, null, undefined, "Task cancelled");
        let observation: BrowserObservation;
        try {
          observation = await this.session.observe();
        } catch (error) {
          return result("failed", actions, null, undefined, errorMessage(error));
        }

        let decision;
        try {
          decision = parseAgentDecision(
            await this.provider.nextAction({
              goal: input.goal,
              observation,
              history: actions,
            }),
          );
        } catch (error) {
          return result("failed", actions, observation, undefined, errorMessage(error));
        }
        if (decision.type === "finish") {
          let verified = false;
          try {
            verified =
              (await this.options.hooks?.verifyFinish?.({
                goal: input.goal,
                output: decision.output,
                observation,
                actions,
              })) ?? false;
          } catch {
            verified = false;
          }
          return verified
            ? result("completed", actions, observation, decision.output)
            : result(
                "indeterminate",
                actions,
                observation,
                undefined,
                "Final result was not independently verified",
              );
        }

        const status = await this.perform(decision.action, actions, observation);
        if (status === "rejected")
          return result(
            "blocked",
            actions,
            observation,
            undefined,
            "Action was denied by policy or verifier",
          );
        if (status === "indeterminate")
          return result(
            "indeterminate",
            actions,
            observation,
            undefined,
            "Action outcome requires reconciliation",
          );
      }
      return result(
        "step_limit",
        actions,
        await safeObserve(this.session),
        undefined,
        "Agent reached maxSteps",
      );
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async perform(
    action: BrowserAction,
    history: AgentActionRecord[],
    existingObservation?: BrowserObservation,
  ): Promise<VerificationStatus> {
    let before: BrowserObservation;
    try {
      before = existingObservation ?? (await this.session.observe());
    } catch {
      return "indeterminate";
    }
    const policy = this.options.policy ?? defaultPolicy;
    let authorized: boolean;
    try {
      authorized = await policy.authorize(action, before);
    } catch {
      return "rejected";
    }
    if (!authorized) return "rejected";

    // The standalone verifier must establish a false baseline before any
    // effectful action. Without it, an already true condition proves nothing.
    if (!this.options.hooks?.verifyAction && isMutation(action) && action.postcondition) {
      try {
        const condition = action.postcondition;
        const alreadyTrue =
          condition.kind === "url"
            ? new URL(await this.session.url()).href === new URL(condition.equals).href
            : (await this.session.text(condition.selector)).includes(condition.includes);
        if (alreadyTrue) return "indeterminate";
      } catch {
        return "indeterminate";
      }
    }

    let execution: ActionExecution;
    try {
      execution = await executeAction(this.session, action, this.options.hooks, before);
    } catch {
      // A beforeAction failure happens before the browser operation starts.
      return "rejected";
    }
    let verification: VerificationStatus;
    try {
      verification = this.options.hooks?.verifyAction
        ? await this.options.hooks.verifyAction(execution, action, this.session)
        : await defaultVerification(execution, action, this.session);
    } catch {
      verification = "indeterminate";
    }
    history.push(safeRecord(execution, verification));
    return verification;
  }
}

function isMutation(
  action: BrowserAction,
): action is Extract<BrowserAction, { type: "click" | "fill" | "select" }> {
  return action.type === "click" || action.type === "fill" || action.type === "select";
}

/** Executes once. An error never causes an automatic replay. */
export async function executeAction(
  session: BrowserSession,
  action: BrowserAction,
  hooks: AgentHooks = {},
  before?: BrowserObservation,
): Promise<ActionExecution> {
  const pre = before ?? (await session.observe());
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const beforeDigest = observationDigest(pre);
  await hooks.beforeAction?.(
    {
      id,
      action: safeAction(action),
      before: safeObservation(pre),
      beforeDigest,
      startedAt,
    },
    action,
    session,
  );
  let executed = false;
  let result: string | undefined;
  let error: string | undefined;
  try {
    switch (action.type) {
      case "navigate":
        await session.navigate(action.url);
        break;
      case "click":
        await session.click(action.selector);
        break;
      case "fill":
        await session.fill(action.selector, action.value);
        break;
      case "select":
        await session.select(action.selector, action.value);
        break;
      case "text":
        result = await session.text(action.selector);
        break;
    }
    executed = true;
  } catch (cause) {
    error = errorMessage(cause);
  }
  const after = await safeObserve(session);
  const execution: ActionExecution = {
    id,
    action: safeAction(action),
    before: pre,
    beforeDigest,
    after,
    afterDigest: after ? observationDigest(after) : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(result === undefined ? {} : { result }),
    executed,
    ...(error === undefined ? {} : { error }),
  };
  try {
    await hooks.afterAction?.(execution);
  } catch (cause) {
    return { ...execution, error: `After-action hook failed: ${errorMessage(cause)}` };
  }
  return execution;
}

const defaultPolicy: ActionPolicy = {
  authorize: (action) => action.type === "navigate" || action.type === "text",
};

async function defaultVerification(
  execution: ActionExecution,
  originalAction: BrowserAction,
  session: BrowserSession,
): Promise<VerificationStatus> {
  if (!execution.executed || execution.error || !execution.after) return "indeterminate";
  if (originalAction.type === "text") return "verified";
  if (originalAction.type === "navigate") {
    try {
      const expected = new URL(originalAction.url);
      const actual = new URL(execution.after.url);
      return expected.href === actual.href ? "verified" : "indeterminate";
    } catch {
      return "indeterminate";
    }
  }
  const condition = originalAction.postcondition;
  if (!condition) return "indeterminate";
  try {
    if (condition.kind === "url") {
      return new URL(await session.url()).href === new URL(condition.equals).href
        ? "verified"
        : "indeterminate";
    }
    return (await session.text(condition.selector)).includes(condition.includes)
      ? "verified"
      : "indeterminate";
  } catch {
    return "indeterminate";
  }
}

function safeAction(action: BrowserAction): BrowserAction {
  if (action.type === "fill")
    return { type: "fill", selector: action.selector, value: "[REDACTED]" };
  if (action.type === "click") return { type: "click", selector: action.selector };
  if (action.type === "select")
    return { type: "select", selector: action.selector, value: action.value };
  if (action.type !== "navigate") return action;
  try {
    const url = new URL(action.url);
    url.search = "";
    url.hash = "";
    return { type: "navigate", url: url.toString() };
  } catch {
    return { type: "navigate", url: "[INVALID URL]" };
  }
}

function safeObservation(observation: BrowserObservation): BrowserObservation {
  let url = observation.url;
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    url = parsed.toString();
  } catch {
    url = "[INVALID URL]";
  }
  return {
    url,
    title: observation.title.slice(0, 160),
    text: "[REDACTED]",
    links: [],
    controls: [],
    fields: [],
  };
}

function safeRecord(
  execution: ActionExecution,
  verification: VerificationStatus,
): AgentActionRecord {
  return {
    ...execution,
    action: safeAction(execution.action),
    before: safeObservation(execution.before),
    after: execution.after ? safeObservation(execution.after) : null,
    result: execution.result === undefined ? undefined : "[REDACTED]",
    error: execution.error ? "Browser action failed; inspect local diagnostics" : undefined,
    verification,
  };
}

function result(
  status: AgentResult["status"],
  actions: AgentActionRecord[],
  observation: BrowserObservation | null,
  output?: unknown,
  error?: string,
): AgentResult {
  return {
    status,
    actions,
    finalObservation: observation ? safeObservation(observation) : null,
    output: output ?? null,
    ...(error ? { error } : {}),
  };
}

async function safeObserve(session: BrowserSession): Promise<BrowserObservation | null> {
  try {
    return await session.observe();
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

export function observationDigest(observation: BrowserObservation): string {
  return createHash("sha256").update(JSON.stringify(observation)).digest("hex");
}
