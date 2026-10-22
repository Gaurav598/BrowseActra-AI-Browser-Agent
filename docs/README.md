# BrowseActra documentation

These documents describe the project-owned TypeScript application under `apps/` and `packages/browseactra-*`. They are the current product documentation.

| Document                                                                     | Purpose                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Architecture](ARCHITECTURE.md)                                              | Component boundaries and request-to-result path.                            |
| [System design](SYSTEM_DESIGN.md)                                            | Job states, leases, persistence, and uncertain actions.                     |
| [API](API.md)                                                                | Local HTTP contract and authentication.                                     |
| [Development](DEVELOPMENT.md)                                                | Local prerequisites, setup, and commands.                                   |
| [Testing](TESTING.md)                                                        | Deterministic checks and browser test expectations.                         |
| [Security](SECURITY.md)                                                      | Trust boundaries, defaults, and limitations.                                |
| [Performance](PERFORMANCE.md)                                                | Current measurement status and benchmark method.                            |
| [Design decisions](DECISIONS/0001-modular-monolith-and-uncertain-actions.md) | Why the first implementation uses a local service and fail-closed recovery. |
| [Engineering roadmap](ENGINEERING_ROADMAP.md)                                | Proposed follow-up work, separated from implemented features.               |
| [Migration validation](MIGRATION_VALIDATION.md)                              | Baseline checks for the initial Stagehand import.                           |

The versioned site under `packages/docs` was imported with Stagehand. It describes the inherited SDKs and external Browserbase services; it is **not** the current BrowseActra application guide and is not configured for publication. It remains available as historical and compatibility reference while retained SDK modules are evaluated. See [`UPSTREAM.md`](../UPSTREAM.md) for provenance and license information.
