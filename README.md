<p align="center"><img src="media/browseactra-mark.svg" alt="BrowseActra mark" width="84" height="84"></p>

# BrowseActra — AI Browser Agent & Automation Platform

BrowseActra runs browser jobs through a project-owned TypeScript application: a local HTTP API, bounded worker, SQLite job ledger, Playwright-backed browser session, typed agent loop, action verifier, SDK, CLI, and web console. It can read a real page using a deterministic offline provider or use a configured OpenAI-compatible model for broader goals. Every action goes through trusted policy and returns a verification outcome; a model's success claim alone is not accepted as proof.

This repository began as an import of Browserbase's open-source Stagehand. BrowseActra's application modules are new work; the original SDKs, protocol, extension, integrations, and evaluation code remain in the repository with accurate attribution. The new local application path does not use the inherited SDK as its browser engine. See [UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE). BrowseActra is independently maintained and is not affiliated with or endorsed by Browserbase.

## Run the local application

Prerequisites: Node.js 24.18 or later, pnpm, Python 3 for the static fixture server, and an installed Chromium browser. The browser download is a one-time prerequisite; no model key or paid service is needed for the deterministic example.

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/browseactra-runtime exec playwright install chromium
pnpm build:browseactra
```

Start the deterministic fixture in one terminal:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs/fixtures
```

Start BrowseActra in another terminal:

```sh
BROWSEACTRA_ALLOWED_HOSTS=127.0.0.1 pnpm --dir apps/api dev
```

Open **http://127.0.0.1:3000/** in a browser, or submit a job from a third terminal:

```sh
pnpm browseactra run "Read the page title" \
  --url http://127.0.0.1:4173/demo.html
```

The result comes from a real local Chromium session. The no-key provider supports the bounded instructions `Read the page title` and `Read the page text`; it is a deterministic interpreter for local use, not a simulated browser. The API runs the worker in the same process and stores jobs, events, and receipts in `apps/api/data/browseactra.db` by default. Stop the servers with `Ctrl-C`.

## What the application implements

| Component                                                           | Current behavior                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Browser runtime](packages/browseactra-runtime)                     | Own session interface and Playwright implementation for navigation, click, fill, select, text, and bounded page observation.                    |
| [Agent](packages/browseactra-runtime/src/agent.ts)                  | Observe → decide → policy → execute → verify loop with a step limit and cancellation.                                                           |
| [Model providers](packages/browseactra-runtime/src/provider.ts)     | Deterministic provider for tests and an optional OpenAI-compatible Chat Completions adapter.                                                    |
| [Action verifier](packages/browseactra-verifier)                    | Explicit `verified`, `rejected`, or `indeterminate` receipts from observed conditions.                                                          |
| [Executor](packages/browseactra-executor)                           | Wires browser, provider, action policy, events, and receipts into one job execution.                                                            |
| [API and worker](apps/api)                                          | Versioned job endpoints, bearer-key option, SQLite idempotency, bounded concurrent claims, lease tokens, cancellation, and restart uncertainty. |
| [SDK](packages/browseactra-sdk) and [CLI](packages/browseactra-cli) | Project-owned clients for creating, inspecting, waiting for, and cancelling jobs.                                                               |
| [Web console](apps/web)                                             | Real task submission, status, progress events, receipts, structured output, and cancellation through the API.                                   |

The architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the [system design](docs/SYSTEM_DESIGN.md). The first implementation is a modular monolith with one local API/worker process. It is not yet a multi-host distributed system or a resumable workflow engine with step checkpoints.

## Model-backed tasks and action policy

Set `BROWSEACTRA_MODEL_API_KEY` and `BROWSEACTRA_MODEL_NAME` to enable the OpenAI-compatible provider. `BROWSEACTRA_MODEL_BASE_URL` can point to a compatible HTTPS endpoint or a loopback test server. Model calls may incur charges; the normal local demonstration and automated tests do not require one.

The default policy allows navigation and reading text. Click, fill, and select require both `BROWSEACTRA_ALLOW_MUTATIONS=true` and an exact trusted entry in `BROWSEACTRA_APPROVED_MUTATIONS` for the target host, action type, and selector. The action must declare a postcondition that was false before execution and true afterward. A matching label or webpage instruction never grants approval. Model-generated final output is accepted only when its values are directly grounded in observed browser state; unsupported summaries or claims become `indeterminate`. See [docs/SECURITY.md](docs/SECURITY.md) before enabling mutations.

Other configuration includes `BROWSEACTRA_HOST` (default `127.0.0.1`), `BROWSEACTRA_PORT` (default `3000`), `BROWSEACTRA_DATABASE_PATH`, `BROWSEACTRA_ALLOWED_HOSTS`, `BROWSEACTRA_API_KEY`, and `BROWSEACTRA_MAX_CONCURRENT` (default `2`). Every API browser target needs an explicit operator host allowlist entry; a non-loopback bind also requires a strong key. Details are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## API and SDK

The versioned API accepts jobs at `POST /api/v1/jobs` and exposes job lists, details, cancellation, events, and verification receipts. It serves the UI at `/`. See [docs/API.md](docs/API.md) for request validation, authentication, errors, and SSE behavior.

The project-owned TypeScript SDK uses the same API:

```typescript
import { BrowseActraClient } from "@browseactra/sdk";

const client = new BrowseActraClient({ baseUrl: "http://127.0.0.1:3000" });
const job = await client.jobs.create({
  instruction: "Read the page title",
  url: "http://127.0.0.1:4173/demo.html",
});
const result = await client.jobs.wait(job.id);
console.log(result.status, result.result);
```

`@browseactra/sdk` is currently a private workspace package, not a published npm release. A caller outside this workspace can use the documented HTTP API.

## Development and testing

```sh
node scripts/brand-check.mjs
pnpm build:browseactra
pnpm typecheck:browseactra
pnpm test:browseactra
pnpm exec tsx tests/e2e/local-browser.ts
```

The [testing guide](docs/TESTING.md) separates offline unit checks from real-browser integration and manual smoke tests. [Performance notes](docs/PERFORMANCE.md) state which measurements have not yet been established. The [engineering roadmap](docs/ENGINEERING_ROADMAP.md) tracks remaining work, including durable step checkpoints, richer verification, DNS-aware egress controls, human approval, and multi-host coordination.

## Scope of the imported foundation

The historical Stagehand-derived packages remain under `packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-go`, `packages/protocol`, `packages/extension`, `packages/cli`, `packages/integrations`, `packages/evals`, and `packages/docs`. Their code identifiers and dependency references are retained where required for compatibility and attribution. The versioned site in `packages/docs` is an imported SDK reference, not the current BrowseActra application documentation. The [documentation index](docs/README.md) points to current guides.

The original root MIT license and nested CLI MIT notice are preserved. Historical releases in [CHANGELOG.md](CHANGELOG.md) remain labeled as Stagehand history; the initial BrowseActra entry describes the repository migration. Contributions and reports belong to this repository's [issue tracker](https://github.com/Gaurav598/BrowseActra-AI-Browser-Agent/issues) and [contributor guide](CONTRIBUTING.md).
