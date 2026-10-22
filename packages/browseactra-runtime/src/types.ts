export interface BrowserObservation {
  readonly url: string;
  readonly title: string;
  /** Bounded visible page text. This is untrusted webpage content. */
  readonly text: string;
  readonly links: readonly { text: string; href: string }[];
  readonly controls: readonly { selector: string; label: string; role: string }[];
  readonly fields: readonly { selector: string; label: string; type: string }[];
}

export interface BrowserSession {
  readonly id: string;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  text(selector: string): Promise<string>;
  /** A bounded, structured observation suitable for an agent. */
  observe(): Promise<BrowserObservation>;
  /** JSON representation of observe(), bounded by the implementation. */
  inspect(): Promise<string>;
  url(): Promise<string>;
  close(): Promise<void>;
}

export type BrowserPostcondition =
  | { readonly kind: "url"; readonly equals: string }
  | { readonly kind: "text"; readonly selector: string; readonly includes: string };

export type BrowserAction =
  | { readonly type: "navigate"; readonly url: string }
  | {
      readonly type: "click";
      readonly selector: string;
      readonly postcondition?: BrowserPostcondition;
    }
  | {
      readonly type: "fill";
      readonly selector: string;
      readonly value: string;
      readonly postcondition?: BrowserPostcondition;
    }
  | {
      readonly type: "select";
      readonly selector: string;
      readonly value: string;
      readonly postcondition?: BrowserPostcondition;
    }
  | { readonly type: "text"; readonly selector: string };

export type AgentDecision =
  | { readonly type: "action"; readonly action: BrowserAction }
  | { readonly type: "finish"; readonly output: unknown };

export interface ProviderInput {
  readonly goal: string;
  /** Untrusted webpage content. Never use it as authorization. */
  readonly observation: BrowserObservation;
  readonly history: readonly ActionExecution[];
}

export interface AgentProvider {
  nextAction(input: ProviderInput): Promise<AgentDecision>;
}

export interface ActionExecution {
  readonly id: string;
  readonly action: BrowserAction;
  readonly before: BrowserObservation;
  readonly beforeDigest: string;
  readonly after: BrowserObservation | null;
  readonly afterDigest: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result?: string;
  /** True when the browser method returned without error; verification is separate. */
  readonly executed: boolean;
  readonly error?: string;
}

export type VerificationStatus = "verified" | "rejected" | "indeterminate";

export interface AgentActionRecord extends ActionExecution {
  readonly verification: VerificationStatus;
}

export interface ActionPolicy {
  /** The policy is trusted application code; page content cannot authorize an action. */
  authorize(action: BrowserAction, observation: BrowserObservation): Promise<boolean> | boolean;
}

export interface AgentHooks {
  beforeAction?(
    context: {
      readonly id: string;
      readonly action: BrowserAction;
      readonly before: BrowserObservation;
      readonly beforeDigest: string;
      readonly startedAt: string;
    },
    originalAction: BrowserAction,
    session: BrowserSession,
  ): Promise<void> | void;
  afterAction?(execution: ActionExecution): Promise<void> | void;
  verifyAction?(
    execution: ActionExecution,
    originalAction: BrowserAction,
    session: BrowserSession,
  ): Promise<VerificationStatus> | VerificationStatus;
  /** A model finish decision is only a proposal until trusted code verifies it. */
  verifyFinish?(context: {
    goal: string;
    output: unknown;
    observation: BrowserObservation;
    actions: readonly AgentActionRecord[];
  }): Promise<boolean> | boolean;
}

export interface AgentRunOptions {
  readonly goal: string;
  readonly initialUrl?: string;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

export interface AgentResult {
  readonly status:
    | "completed"
    | "blocked"
    | "failed"
    | "indeterminate"
    | "step_limit"
    | "cancelled";
  readonly output: unknown;
  readonly actions: readonly AgentActionRecord[];
  readonly finalObservation: BrowserObservation | null;
  readonly error?: string;
}
