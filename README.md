<p align="center">
  <img src="media/browseactra-mark.svg" alt="BrowseActra mark" width="84" height="84">
</p>

# BrowseActra — AI Browser Agent & Automation Platform

BrowseActra is an independently maintained browser automation project built from the open-source [Stagehand](https://github.com/browserbase/stagehand) foundation. This repository includes a browser-side runtime, a shared JSON-RPC protocol, SDKs, integrations, documentation, and an evaluation harness. The current implementation is inherited from Stagehand; BrowseActra-specific distributed workflow systems are [planned](docs/ENGINEERING_ROADMAP.md), not yet shipped.

The SDKs retain their existing `Stagehand` classes, package names, Python module, and Go import path for compatibility. Those identifiers describe the imported API and do not imply that BrowseActra is affiliated with Browserbase.

## What works in the current codebase

- Local Chrome automation and optional Browserbase-hosted sessions through the existing SDKs.
- Natural-language `act()`, `observe()`, and schema-guided `extract()` operations, alongside direct page and locator control.
- A browser extension that executes the automation runtime and communicates with SDK clients through the shared protocol.
- TypeScript, Python, and Go SDK source trees, plus integrations, examples, docs, and evaluations.
- Timeouts, cancellation handling, trace propagation, and optional caching in specific paths. These are SDK-level mechanisms, not a durable distributed job system.

Model-backed actions can incur provider charges. Browserbase sessions require separate credentials and may incur charges; neither is needed for the offline build and unit-test workflow.

## Repository layout

| Path                                             | Responsibility                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| [`packages/protocol`](packages/protocol)         | Shared types, schemas, and JSON-RPC contract.                      |
| [`packages/extension`](packages/extension)       | Runtime executed inside Chrome.                                    |
| [`packages/sdk-ts`](packages/sdk-ts)             | TypeScript SDK and local/remote browser connections.               |
| [`packages/sdk-python`](packages/sdk-python)     | Python SDK and generated protocol models.                          |
| [`packages/sdk-go`](packages/sdk-go)             | Go SDK and generated protocol models.                              |
| [`packages/integrations`](packages/integrations) | Framework and agent integrations.                                  |
| [`packages/cli`](packages/cli)                   | Existing `browse` CLI, including Browserbase-specific commands.    |
| [`packages/evals`](packages/evals)               | Evaluation harness and datasets; some runs need external services. |
| [`packages/docs`](packages/docs)                 | Versioned documentation source.                                    |

The SDK sends requests over Chrome DevTools Protocol to the extension. The protocol package is the contract shared by clients and runtime. Generated Python and Go files depend on those schemas, so API identifiers have intentionally not been renamed in this migration.

## Prerequisites and setup

- Node.js 24.x, version 24.18 or later, is the workspace's declared development runtime (`>=22.18.0` is the package engine minimum).
- pnpm 11.11.0, as declared by the root package manifest.
- Python 3.11 or later and `uv` for the Python SDK.
- Go 1.26 for the Go SDK.
- Chrome for local browser examples; `just` is optional but provides cross-language recipes.

```sh
git clone https://github.com/Gaurav598/BrowseActra-AI-Browser-Agent.git
cd BrowseActra-AI-Browser-Agent
pnpm install --frozen-lockfile
pnpm --filter ./packages/protocol build
pnpm --filter ./packages/extension build
pnpm --filter ./packages/sdk-ts build
```

For Python and Go development, also run:

```sh
uv --directory packages/sdk-python sync --locked
go -C packages/sdk-go mod download
go -C packages/sdk-go/internal/generator mod download
```

`just install` is the existing convenience recipe for the three ecosystems.

## Environment configuration

Copy `.env.example` to `.env` and set only the credentials needed for the example or integration you run:

```sh
cp .env.example .env
```

`OPENAI_API_KEY` is used by the model-backed TypeScript example below. `BROWSERBASE_API_KEY` is optional for local Chrome operation and needed for Browserbase cloud sessions. Keep real keys outside Git; `.env` is ignored. A custom Chrome binary can be selected with `CHROME_PATH`.

The inherited CLI sends no analytics by default. A maintainer can opt into a project-owned collector by setting both `BROWSEACTRA_TELEMETRY_HOST` and `BROWSEACTRA_TELEMETRY_PROJECT_TOKEN`; no Browserbase collector or token is configured in this repository.

## Build, checks, and tests

Run from the repository root after installation:

```sh
pnpm --filter ./packages/protocol build
pnpm --filter ./packages/extension build
pnpm --filter ./packages/sdk-ts build
pnpm --filter ./packages/protocol test:unit
pnpm --filter ./packages/extension test:unit
pnpm --filter ./packages/sdk-ts test:unit
pnpm --filter ./packages/protocol typecheck
pnpm --filter ./packages/extension typecheck
pnpm --filter ./packages/sdk-ts typecheck
pnpm fmt:check
pnpm lint
uv --directory packages/sdk-python run --locked pytest
go -C packages/sdk-go test ./...
```

`just check` and `just test` include broader cross-language validation. Browser-backed tests, evaluations, and examples have additional prerequisites; review their commands before running them. Build and verification outcomes for this migration belong in the migration commit or CI record, rather than being inferred from this README.

## Basic usage

This checked-in example exercises the actual TypeScript SDK against a local browser and `example.com`:

```sh
pnpm exec tsx packages/sdk-ts/examples/act.ts
```

It loads `.env`, requires `OPENAI_API_KEY`, opens Chrome, and calls `Stagehand.create()` and `act()`. The SDK import and class name intentionally keep their established identities. See [`packages/sdk-ts/examples/act.ts`](packages/sdk-ts/examples/act.ts) for executable source and [`packages/sdk-ts/examples`](packages/sdk-ts/examples) for more examples.

## Technology and engineering status

The workspace uses TypeScript, Node.js, pnpm, Turbo, Vite, Vitest, Zod, Python, uv, Go, Chrome DevTools Protocol, and a Chrome extension. The imported source includes versioned docs and release tooling. Existing package names and version numbers describe the upstream-compatible SDKs; this repository is not publishing a new BrowseActra package release as part of its initial migration.

The [engineering roadmap](docs/ENGINEERING_ROADMAP.md) starts with deterministic action verification, then durable execution, safe recovery, persistent jobs, worker coordination, and security controls. Each milestone identifies existing upstream capabilities and the missing BrowseActra subsystem.

## Contributing, history, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository's development conventions. [UPSTREAM.md](UPSTREAM.md) records the imported source and attribution. The [changelog](CHANGELOG.md) distinguishes the BrowseActra migration from Stagehand's historical releases.

The repository is licensed under [MIT](LICENSE). The original Browserbase copyright and permission notices remain in the root and nested license files. BrowseActra is independently maintained by [Gaurav598](https://github.com/Gaurav598) and is not affiliated with or endorsed by Browserbase.
