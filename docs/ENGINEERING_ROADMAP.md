# BrowseActra engineering roadmap

**Status:** follow-up engineering. The imported foundation is Stagehand revision [`d16562d`](https://github.com/browserbase/stagehand/commit/d16562dafc402893a65e0fe83e16eacddacb4c58); see [`UPSTREAM.md`](../UPSTREAM.md). BrowseActra's first project-owned runtime, verifier, job API, SQLite ledger, worker, SDK, CLI, and UI are documented in [architecture](ARCHITECTURE.md). The milestones below describe the remaining depth required for a production-oriented platform; they do not claim that every capability has shipped.

## Current progress against the milestones

| Milestone                     | Current project-owned implementation                           | Remaining gap                                                                   |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1. Action verification        | Typed receipts, browser observations, and a verifier module.   | Broader semantic postconditions and independent evidence for every side effect. |
| 2. Durable workflows          | Durable job-level state and events.                            | Serializable multi-step definitions and safe step checkpoints.                  |
| 3. Retry and recovery         | Ambiguous work is marked `indeterminate` rather than replayed. | Typed retry classification and reconciliation policies.                         |
| 4. Job state and idempotency  | SQLite jobs and caller idempotency keys.                       | Production storage operations and retention.                                    |
| 5. Worker coordination        | Bounded local workers, leases, and fencing tokens.             | Multi-host coordination and session handoff.                                    |
| 6. Cancellation and lifecycle | Cancellation request and bounded cleanup path.                 | End-to-end cancellation acknowledgment and leak sweeping.                       |
| 7. Session isolation          | Per-job browser context and target restrictions.               | Tenant profiles, DNS-aware egress enforcement, and verified scrubbing.          |
| 8. Prompt injection policy    | Typed model actions and trusted default action policy.         | Human approval tokens and complete high-impact action policy.                   |
| 9. Observability              | Job events and local execution records.                        | Correlated traces and operational metrics.                                      |
| 10. Evaluation                | Imported eval harness remains available.                       | Pinned BrowseActra-specific offline benchmarks.                                 |

## Existing foundation

- `packages/protocol` defines schemas and JSON-RPC methods; `packages/extension` executes browser-side `act`, `observe`, `extract`, and direct page operations.
- `packages/sdk-ts/src/rpcClient.ts` already propagates trace context and applies method-specific response deadlines; `abort.ts`, `timeouts.ts`, and the extension's `Progress` handling provide local cancellation and timeout primitives.
- `packages/extension/services/actService.ts` already supports deterministic actions, model inference, self-healing, and optional cache replay. `packages/extension/services/cacheService.ts` provides best-effort caching where Browserbase transport is configured.
- `packages/sdk-ts/src/batch.ts` exposes an experimental in-session callback batch with a timeout. This is not durable execution; the callback and its state live in a process and browser session.
- `packages/evals` already contains datasets and verifier gates. Those evaluate tasks, but do not provide production action receipts or a distributed scheduler.
- The SDKs can launch or connect to local Chrome and Browserbase sessions. They do not provide a BrowseActra-owned worker fleet, persistent job store, or tenant control plane.

The imported foundation above is verified against the source revision. Milestones below are ordered by dependency, with correctness evidence before distributed execution.

## 1. Deterministic browser action verification

**Existing functionality:** The imported `act()` and eval gates remain available. BrowseActra now records bounded action receipts with observed URL/text postconditions and rejects already-true mutation postconditions.

**Gap:** The local verifier supports narrow explicit conditions; semantic predicates, evidence hashes, and independently assessed effects on remote systems remain open.

**Architecture:** Extend the existing action receipt contract with versioned predicates, scoped evidence hashes, page/session identity, and trace IDs. Keep verification decisions separate from model self-report.

**Modules:** `packages/browseactra-verifier`, `packages/browseactra-executor`, and `packages/browseactra-runtime`; integrate inherited SDK APIs only after compatibility tests.

**States and failures:** `prepared → executing → verifying → verified | rejected | indeterminate`. Navigation, stale locators, ambiguous timeouts, and disconnected browsers produce `indeterminate`; do not silently retry the action.

**Tests:** Fake browser state transitions, idempotent and non-idempotent actions, stale DOM, navigation during verification, disconnected sessions, and receipt schema round trips.

**Security:** Redact sensitive DOM fields from receipts, bound evidence size, and ensure a page cannot supply the verifier's policy. **Metrics:** verified rate, indeterminate rate, verification latency, and receipt bytes. **Done:** every opt-in action yields a machine-readable receipt and failure mode, with no duplicate side effect in fault-injection tests.

## 2. Durable workflow execution and checkpointing

**Existing functionality:** `experimentalBatch()` groups callbacks inside a live session; RPC and extension progress provide in-memory execution state.

**Gap:** Work disappears on process restart, and a batch has no resumable, versioned checkpoint.

**Architecture:** Define a declarative workflow of serializable steps and checkpoint after each verified step. Store workflow definition version, input digest, step result, browser artifact references, and latest committed step in a transaction. Resume from a checkpoint only after validating its schema and session assumptions.

**Modules:** New workflow runner and storage adapter; reuse action receipts from milestone 1 and SDK calls in `packages/sdk-ts/src/stagehand.ts`.

**States and failures:** `created → running → checkpointing → suspended | completed | failed`; a crash between side effect and checkpoint is marked ambiguous and requires reconciliation. **Tests:** kill/restart at every state boundary, incompatible workflow version, corrupt checkpoint, and lost browser. **Security:** encrypt or omit sensitive step data; separate credentials from checkpoint contents. **Metrics:** recovery time, checkpoint write latency, resume success rate. **Done:** a stopped runner resumes a multi-step workflow without rerunning a committed step.

## 3. Retry classification and safe recovery

**Existing functionality:** Protocol errors can carry a retryable hint; RPC deadlines, abort signals, and cache fallback exist in specific paths.

**Gap:** There is no workflow-level decision that distinguishes transient read failures from uncertain writes, nor a safe recovery plan after ambiguous execution.

**Architecture:** Add a typed failure taxonomy (`transient`, `permanent`, `policy`, `ambiguous`) and an explicit recovery policy per step. Retry only operations declared safe or proven to have had no effect. Otherwise reconcile through the verified postcondition or pause for review. Bound attempts with exponential backoff and a total deadline.

**Modules:** Workflow runner, protocol error mapping, `packages/sdk-ts/src/rpcErrors.ts`, `packages/extension/services/actService.ts` as read-only integration points.

**States and failures:** `failed → classified → retry_wait | reconcile | terminal`; network loss after a click is ambiguous even when transport reports a timeout. **Tests:** injected disconnect before/after action, malformed response, throttling, and repeated transient failures. **Security:** retries must not repeat purchases, submissions, or permission changes without proof of safety. **Metrics:** retry amplification, recovery success, duplicate side-effect incidents. **Done:** policy tests prove ambiguous writes never auto-replay.

## 4. Persistent job state and idempotency

**Existing functionality:** The imported RPC uses connection-scoped IDs. BrowseActra's SQLite job store now persists job identity, idempotency keys, events, receipts, and ownership tokens.

**Gap:** The local ledger lacks multi-tenant key scope, a durable dispatch outbox, migrations, and retention controls for production use.

**Architecture:** Introduce a database-backed job ledger with a caller-supplied idempotency key scoped to tenant and workflow version. Use compare-and-swap transitions and an outbox for dispatch. Persist action receipts and reconcile uncertain work before advancing. Define retention and schema migration rules.

**Modules:** New job API, persistence adapter, workflow runner; keep SDK package internals compatible.

**States and failures:** `queued → leased → running → completed | failed | cancelled`; duplicate submission returns the same job ID, while a conflicting payload for one key is rejected. **Tests:** concurrent duplicate requests, database restart, transaction rollback, and outbox redelivery. **Security:** tenant-scoped keys, least-privilege database access, retention limits. **Metrics:** duplicate suppression, transaction latency, orphaned jobs. **Done:** repeated identical submissions and dispatcher redelivery produce one logical job outcome.

## 5. Distributed browser worker coordination

**Existing functionality:** BrowseActra's local worker claims SQLite jobs with leases and fencing tokens. Imported SDKs also launch/connect browser sessions.

**Gap:** Multiple hosts cannot coordinate browser sessions or resume a partially completed workflow after worker failure.

**Architecture:** Add workers that lease jobs with a fencing token and heartbeat. The coordinator assigns a compatible browser capability, tracks lease expiry, and prevents stale workers from writing outcomes. A replacement worker resumes only from a durable checkpoint and revalidates session availability.

**Modules:** New coordinator and worker packages, job ledger, browser factory integration from `packages/sdk-ts/src/browser/factories.ts`.

**States and failures:** `available → leased → active → draining | lost`; lease expiry does not imply the browser action stopped, so ambiguous actions enter reconciliation. **Tests:** competing workers, clock skew, partition, stale fencing token, browser loss, and rolling drain. **Security:** worker identity, tenant placement, scoped session credentials. **Metrics:** queue wait, lease churn, worker utilization, abandoned sessions. **Done:** a worker crash cannot allow two workers to commit the same step.

## 6. Cancellation, deadlines, and resource lifecycle

**Existing functionality:** The BrowseActra API persists cancellation requests; its worker propagates abort signals and closes owned browser sessions. Imported RPC timeout and cancellation primitives also exist.

**Gap:** Cancellation acknowledgment, durable per-job deadlines, crash cleanup sweeping, and cross-service propagation remain incomplete.

**Architecture:** Store a job deadline and cancellation generation in the ledger. Propagate an end-to-end signal through each layer, then close only resources owned by that job. Record cancellation acknowledgement and cleanup completion separately; sweep leaked sessions after worker loss.

**Modules:** Job runner, coordinator, `packages/sdk-ts/src/abort.ts`, `rpcClient.ts`, browser factories, extension progress.

**States and failures:** `cancel_requested → stopping → cleanup_pending → cancelled`; an unresponsive browser triggers bounded cleanup and an alert. **Tests:** cancellation during inference, navigation, checkpoint write, and worker loss. **Security:** one tenant's cancellation cannot affect another's browser. **Metrics:** cancellation latency, resource leak count, deadline overruns. **Done:** all exit paths release or explicitly account for owned sessions and processes.

## 7. Browser session isolation and security controls

**Existing functionality:** Local and Browserbase connections exist, and the browser context has domain-policy operations in the shared protocol.

**Gap:** A BrowseActra-controlled multi-tenant execution policy and enforceable isolation profile are absent.

**Architecture:** Define a per-job browser profile with allowed origins, network egress, download/upload policy, storage lifetime, and secret injection rules. Allocate isolated browser contexts or processes according to threat level and validate the policy at worker admission and action execution.

**Modules:** Worker allocator, browser factories, `packages/sdk-ts/src/browserContext.ts`, extension runtime and protocol domain policy.

**States and failures:** `profile_validated → allocated → active → scrubbed`; failed scrub quarantines the worker. **Tests:** cross-tenant cookie/storage leakage, forbidden origin, file access, and cleanup after crash. **Security:** default-deny sensitive capabilities and never reuse a dirty profile across tenants. **Metrics:** isolation violations, profile startup latency, scrub failures. **Done:** adversarial tests cannot read another job's session material.

## 8. Prompt-injection defenses and action approval

**Existing functionality:** BrowseActra uses typed model decisions, exact operator-configured mutation approvals, and an independent finish verifier. Imported model prompts and page observations also exist.

**Gap:** Untrusted page text can still influence proposals; interactive human approval tokens and one-time audited decisions are not implemented.

**Architecture:** Keep page content explicitly tainted in the action planner. Evaluate candidate actions against a policy engine using origin, action type, destination, data sensitivity, and step intent. Require a signed human approval token for configured actions; bind it to one action digest and expiry.

**Modules:** New policy engine, action wrapper from milestone 1, `packages/extension/services/actService.ts` integration, protocol approval request/response only if necessary.

**States and failures:** `proposed → policy_checked → approved | denied | review_required → executed`; stale approvals fail closed. **Tests:** injected page instructions, cross-origin exfiltration links, forged approval, replay, and policy version drift. **Security:** browser content never authors policy; approval tokens are single-use and scoped. **Metrics:** policy denials, review latency, override rate. **Done:** protected actions cannot execute without a valid policy decision and auditable approval.

## 9. Observability, tracing, and metrics

**Existing functionality:** BrowseActra persists job events and action receipts. Imported RPC trace context and extension tracing also exist.

**Gap:** A job lacks one correlated trace and consistent metrics from submission through worker, browser action, checkpoint, and cleanup.

**Architecture:** Define trace/span conventions keyed by opaque job and step IDs. Emit state-transition events from the ledger and derive low-cardinality service metrics. Attach action receipt IDs to spans. Sample detailed browser evidence separately from operational telemetry.

**Modules:** `packages/sdk-ts/src/rpcClient.ts`, `packages/extension/tracing.ts`, new job/coordinator instrumentation and metrics exporter.

**States and failures:** Correlation is maintained through retries and worker replacement; exporter failure must not change job outcome. **Tests:** trace propagation through reconnect, retry, and cancellation; cardinality and redaction checks. **Security:** never export page secrets, raw cookies, API keys, or unredacted snapshots by default. **Metrics:** queue latency, step duration, verification rate, retries, token use, and resource leaks. **Done:** one job can be reconstructed from ledger events and trace IDs without sensitive payloads.

## 10. Reproducible evaluation and benchmarking

**Existing functionality:** `packages/evals` includes imported tasks and verifier gates. BrowseActra has a deterministic local browser end-to-end fixture and a small measured smoke benchmark.

**Gap:** The smoke benchmark is too small to support production latency or reliability claims; fault, recovery, and isolation benchmark sets are not yet pinned to a release.

**Architecture:** Build a local deterministic site fixture and fault-injection harness for actions, workflow recovery, worker handoff, and security policies. Pin browser, model stub, dataset revision, seeds, and resource limits. Keep paid external evaluations optional and report their costs separately.

**Modules:** `packages/evals` plus new local fixtures and scenario runner; consume action receipts and job ledger events.

**States and failures:** A run is `configured → executing → verified | invalid`; infra failure is not counted as a successful task. **Tests:** repeated runs on clean environments, verifier disagreement, data leakage, and benchmark version migrations. **Security:** scrub fixtures and prohibit credentialed services in default CI. **Metrics:** verified task success, false-success rate, duplicate actions, recovery time, P95 latency, and cost per successful task. **Done:** CI can reproduce an offline benchmark result with pinned inputs and publish its raw evidence and uncertainty.

## Next implementation slice

Build serializable multi-step workflow checkpoints on top of the existing receipt and SQLite job ledger. Start with a versioned two-step read workflow and crash injection at the browser-effect/receipt boundary. Resume only steps whose receipts were durably committed; mark ambiguous effects for reconciliation. Keep inherited SDK and protocol APIs compatible while the checkpoint model is tested.
