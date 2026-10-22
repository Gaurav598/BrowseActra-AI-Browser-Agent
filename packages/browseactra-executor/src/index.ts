import {
  Agent,
  assertAllowedUrl,
  BrowserFactory,
  OpenAICompatibleProvider,
  type ActionExecution,
  type AgentProvider,
  type BrowserAction,
  type BrowserObservation,
  type BrowserSession,
  type AgentActionRecord,
} from "@browseactra/runtime";
import { createReceipt, type Condition, type Observation } from "@browseactra/action-verifier";

export interface OutputSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean" }>;
  required?: string[];
  additionalProperties?: false;
}

export interface ExecutorOptions {
  modelApiKey?: string;
  modelName?: string;
  modelBaseUrl?: string;
  allowedHosts?: string[];
  browserChannel?: "chrome" | "chromium";
  browserExecutablePath?: string;
  allowMutations?: boolean;
  /** Exact, trusted application configuration. Page labels never grant approval. */
  approvedMutations?: readonly {
    host: string;
    type: "click" | "fill" | "select";
    selector: string;
  }[];
  providerFactory?: () => AgentProvider;
  browserFactory?: {
    open(options: Parameters<typeof BrowserFactory.open>[0]): Promise<BrowserSession>;
  };
}

export interface ExecutorContext {
  signal: AbortSignal;
  recordEvent(type: string, data?: unknown): void;
  recordReceipt(receipt: {
    actionId: string;
    status: "verified" | "rejected" | "indeterminate";
    precondition?: unknown;
    postcondition?: unknown;
    metadata?: unknown;
  }): void;
}

export class ExecutionFailure extends Error {
  constructor(
    message: string,
    readonly outcome: "failed" | "indeterminate",
  ) {
    super(message);
    this.name = "ExecutionFailure";
  }
}

/** Executes real browser work. The default offline grammar is intentionally narrow. */
export function createBrowserExecutor(options: ExecutorOptions = {}) {
  if (options.modelApiKey && !options.modelName && !options.providerFactory) {
    throw new Error("BROWSEACTRA_MODEL_NAME is required with BROWSEACTRA_MODEL_API_KEY");
  }
  return {
    async execute(
      job: { id: string; instruction: string; url: string; outputSchema?: OutputSchema },
      context: ExecutorContext,
    ): Promise<unknown> {
      const host = new URL(job.url).hostname.toLowerCase();
      assertAllowedUrl(job.url, options.allowedHosts ?? []);
      const allowedDomains = options.allowedHosts?.length ? options.allowedHosts : [host];
      context.recordEvent("browser.start", { host });
      const session = await (options.browserFactory ?? BrowserFactory).open({
        allowedDomains,
        channel: options.browserChannel,
        executablePath: options.browserExecutablePath,
        signal: context.signal,
      });
      try {
        const preconditionWasFalse = new Map<string, boolean>();
        const provider =
          options.providerFactory?.() ??
          (options.modelApiKey
            ? new OpenAICompatibleProvider({
                apiKey: options.modelApiKey,
                model: options.modelName!,
                baseUrl: options.modelBaseUrl,
              })
            : new LocalProvider(job.outputSchema));
        const agent = new Agent(session, provider, {
          policy: {
            authorize: (action, observation) => policyAllows(action, observation, options),
          },
          hooks: {
            beforeAction: async (
              { id, action, beforeDigest, startedAt },
              originalAction,
              browserSession,
            ) => {
              if (isMutation(originalAction) && originalAction.postcondition) {
                const condition = originalAction.postcondition;
                try {
                  const wasFalse =
                    condition.kind === "url"
                      ? new URL(await browserSession.url()).href !== new URL(condition.equals).href
                      : !(await browserSession.text(condition.selector)).includes(
                          condition.includes,
                        );
                  preconditionWasFalse.set(id, wasFalse);
                } catch {
                  // Missing baseline evidence cannot prove the action changed state.
                  preconditionWasFalse.set(id, false);
                }
                if (!preconditionWasFalse.get(id)) {
                  context.recordReceipt({
                    actionId: id,
                    status: "rejected",
                    metadata: {
                      reason:
                        "Mutation postcondition was already true or could not be observed before execution",
                    },
                  });
                  context.recordEvent("action.blocked", { id, reason: "missing_false_baseline" });
                  throw new Error(
                    "Mutation requires an observable false postcondition before execution",
                  );
                }
              }
              context.recordEvent("action.started", {
                id,
                action: safeAction(action),
                beforeDigest,
                startedAt,
              });
            },
            verifyAction: async (execution, originalAction, browserSession) => {
              const receipt = await receiptFor(
                execution,
                originalAction,
                browserSession,
                preconditionWasFalse.get(execution.id),
              );
              context.recordReceipt({
                actionId: execution.id,
                status: receipt.status,
                precondition: receipt.precondition,
                postcondition: receipt.postcondition,
                metadata: receipt,
              });
              context.recordEvent("action.finished", { id: execution.id, status: receipt.status });
              return receipt.status;
            },
            verifyFinish: ({ goal, output, observation, actions }) =>
              verifyFinish(goal, output, observation, actions, session),
          },
        });
        const goal = job.outputSchema
          ? `${job.instruction}\nReturn JSON matching this output schema: ${JSON.stringify(job.outputSchema)}`
          : job.instruction;
        const result = await agent.run({ goal, initialUrl: job.url, signal: context.signal });
        context.recordEvent("agent.finished", {
          status: result.status,
          actions: result.actions.length,
        });
        if (result.status === "completed") {
          if (job.outputSchema) {
            const valid = validateOutput(result.output, job.outputSchema);
            context.recordReceipt({
              actionId: "output-schema",
              status: valid ? "verified" : "rejected",
              metadata: {
                reason: valid
                  ? "Output matched the declared schema"
                  : "Output failed declared schema",
              },
            });
            if (!valid)
              throw new ExecutionFailure("Structured output failed its declared schema", "failed");
          }
          return result.output;
        }
        throw new ExecutionFailure(
          result.error ?? `Agent stopped: ${result.status}`,
          result.status === "indeterminate" || result.status === "cancelled"
            ? "indeterminate"
            : "failed",
        );
      } catch (error) {
        if (error instanceof ExecutionFailure) throw error;
        throw new ExecutionFailure(
          error instanceof Error ? error.message : "Browser execution failed",
          "indeterminate",
        );
      } finally {
        await session.close();
      }
    },
  };
}

export function validateOutput(output: unknown, schema: OutputSchema): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  if (schema.required?.some((key) => !(key in record))) return false;
  if (
    schema.additionalProperties === false &&
    Object.keys(record).some((key) => !(key in schema.properties))
  )
    return false;
  for (const [key, property] of Object.entries(schema.properties)) {
    if (key in record && typeof record[key] !== property.type) return false;
  }
  return true;
}

async function receiptFor(
  execution: ActionExecution,
  originalAction: BrowserAction,
  session: BrowserSession,
  preconditionWasFalse?: boolean,
) {
  const before = asEvidence(execution.before);
  const after = execution.after ? asEvidence(execution.after) : undefined;
  const action = originalAction;
  let postcondition: Condition | undefined;
  let postObservation = after;
  if (action.type === "navigate") {
    // URL equality is checked against browser state, rather than the model report.
    postcondition = { kind: "url", equals: action.url };
  } else if (action.type === "text" && execution.result !== undefined) {
    postcondition = { kind: "text", includes: execution.result };
    postObservation = { ...after, text: execution.result } as Observation;
  } else if ("postcondition" in action && action.postcondition) {
    if (action.postcondition.kind === "url") {
      postcondition = { kind: "url", equals: action.postcondition.equals };
    } else {
      postcondition = { kind: "text", includes: action.postcondition.includes };
      try {
        postObservation = {
          ...after,
          text: await session.text(action.postcondition.selector),
        } as Observation;
      } catch {
        postObservation = undefined;
      }
    }
  }
  const receipt = createReceipt({
    id: execution.id,
    action: action.type,
    startedAt: execution.startedAt,
    before,
    after: postObservation,
    postcondition,
    executionError:
      execution.executed && !execution.error
        ? undefined
        : (execution.error ?? "Browser action did not complete"),
  });
  if (
    isMutation(action) &&
    (!postcondition || preconditionWasFalse !== true) &&
    receipt.status === "verified"
  ) {
    return {
      ...receipt,
      status: "indeterminate" as const,
      reason: "Postcondition was already true or had no observable baseline before the action",
    };
  }
  if (isMutation(action) && execution.executed && receipt.status === "rejected") {
    return {
      ...receipt,
      status: "indeterminate" as const,
      reason: "Mutation executed but its intended effect was not observed; side effects may remain",
    };
  }
  return receipt;
}

function asEvidence(observation: BrowserObservation): Observation {
  return { url: observation.url, title: observation.title, text: observation.text };
}

function safeAction(action: BrowserAction): unknown {
  if (action.type === "fill")
    return { type: "fill", selector: action.selector, value: "[REDACTED]" };
  return action;
}

function isMutation(
  action: BrowserAction,
): action is Extract<BrowserAction, { type: "click" | "fill" | "select" }> {
  return action.type === "click" || action.type === "fill" || action.type === "select";
}

function policyAllows(
  action: BrowserAction,
  observation: BrowserObservation,
  options: ExecutorOptions,
): boolean {
  if (action.type === "navigate" || action.type === "text") return true;
  if (!options.allowMutations || !action.postcondition) return false;
  let host: string;
  try {
    host = new URL(observation.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    options.approvedMutations?.some(
      (entry) =>
        entry.host.toLowerCase() === host &&
        entry.type === action.type &&
        entry.selector === action.selector,
    ) ?? false
  );
}

async function verifyFinish(
  goal: string,
  output: unknown,
  observation: BrowserObservation,
  actions: readonly AgentActionRecord[],
  session: BrowserSession,
): Promise<boolean> {
  if (actions.some((action) => action.verification !== "verified")) return false;
  const instruction = goal.split("\n", 1)[0];
  if (
    /\b(click|fill|select|submit|buy|purchase|delete|remove|send|transfer)\b/i.test(instruction) &&
    !actions.some((action) => isMutation(action.action) && action.verification === "verified")
  )
    return false;
  const sources = new Set([observation.title, observation.text, observation.url]);
  for (const action of actions) {
    if (action.verification !== "verified" || action.action.type !== "text") continue;
    try {
      sources.add(await session.text(action.action.selector));
    } catch {
      return false;
    }
  }
  const grounded = (value: unknown): boolean =>
    typeof value === "string" && value.length > 0 && sources.has(value);
  if (grounded(output)) return true;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const values = Object.values(output);
  return values.length > 0 && values.every(grounded);
}

class LocalProvider implements AgentProvider {
  constructor(private readonly outputSchema?: OutputSchema) {}

  async nextAction({ goal, observation }: { goal: string; observation: BrowserObservation }) {
    const instruction = goal.split("\n", 1)[0].trim();
    if (/^(?:read|extract|get|show)\s+(?:the\s+)?(?:page\s+)?title[.!]?$/i.test(instruction)) {
      const output = { title: observation.title, url: observation.url };
      return { type: "finish" as const, output: this.selectOutput(output) };
    }
    if (/^(?:read|extract|get|show)\s+(?:the\s+)?(?:page\s+)?text[.!]?$/i.test(instruction)) {
      const output = { text: observation.text, url: observation.url };
      return { type: "finish" as const, output: this.selectOutput(output) };
    }
    throw new ExecutionFailure(
      "Offline mode supports 'Read the page title' or 'Read the page text'. Configure a model for other goals.",
      "failed",
    );
  }

  private selectOutput(output: Record<string, string>): Record<string, string> {
    if (!this.outputSchema) return output;
    return Object.fromEntries(
      Object.entries(output).filter(([key]) => key in this.outputSchema!.properties),
    );
  }
}
