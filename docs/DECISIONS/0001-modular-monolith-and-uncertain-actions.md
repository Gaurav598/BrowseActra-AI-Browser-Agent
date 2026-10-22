# ADR 0001: Local modular monolith with fail-closed action recovery

**Status:** accepted for the first BrowseActra application implementation.

## Context

A browser side effect cannot be rolled back with a database transaction. If a worker clicks a purchase or submits a form and then crashes before recording success, the next worker cannot infer from lease expiry whether the action happened. The initial product also needs a local demonstration without requiring a message broker or cloud infrastructure.

## Decision

The API and a bounded worker use one SQLite job ledger with durable events and verification receipts. Worker claims carry an ownership token. A stale worker cannot commit a result after losing its lease. On restart or lease expiry, interrupted work becomes `indeterminate` and requires reconciliation; the system does not automatically replay an uncertain browser action. The browser engine, agent, verifier, store, and API have separate TypeScript module boundaries while sharing a process and repository.

## Alternatives considered

- **Requeue every expired lease:** simpler throughput, but can duplicate irreversible browser effects. Rejected until actions have proven idempotency or external reconciliation.
- **Exactly-once promise backed by SQL transactions:** a transaction cannot atomically include a remote website action. Rejected as an incorrect guarantee.
- **Broker and separate services from day one:** adds deployment and failure modes before load requires them. Deferred until queue or worker isolation measurements justify it.
- **Keep the inherited SDK as the new core:** preserves mature features, but leaves public identity and execution semantics dependent on the imported product. The project-owned path instead uses Playwright through its own browser contract.

## Consequences

SQLite makes local setup small and checkpoint state inspectable. A single-host process is the supported first deployment boundary; it is not a claim of production multi-host scheduling. The ledger can preserve that an action is uncertain, but it cannot by itself prove whether a remote site applied the action. Future recovery must use independently checked postconditions or human review before retrying side effects.

## Validation

The implementation should be accepted only with tests for concurrent claims, stale tokens, cancellation races, restart recovery, and a crash between browser execution and result persistence. See [testing](../TESTING.md) for the commands actually run in this repository.
