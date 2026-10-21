# Contributing to BrowseActra

BrowseActra is independently maintained at <https://github.com/Gaurav598/BrowseActra-AI-Browser-Agent>. Open an issue in this repository to discuss a bug, feature, or large change. The repository is derived from Stagehand; read [UPSTREAM.md](UPSTREAM.md) before changing attribution or public package identifiers.

## Repository architecture

The TypeScript SDK connects to a Chrome extension runtime over Chrome DevTools Protocol and a JSON-RPC contract in [`packages/protocol`](packages/protocol). The TypeScript, Python, and Go SDKs use that contract. Python and Go include generated code; change the source schema and regenerate rather than editing generated files directly. See the [protocol guide](packages/protocol/README.md) for that workflow.

Existing `Stagehand`, `stagehand`, `@browserbasehq/`, and Go module identifiers remain for compatibility. A public rename needs a separate migration plan with tests across consumers.

## Development setup

Install Node.js 24.x (version 24.18 or later), pnpm 11.11.0, Python 3.11 or later, uv, and Go 1.26. Chrome is needed for local browser tests and examples. From the repository root:

```sh
pnpm install --frozen-lockfile
uv --directory packages/sdk-python sync --locked
go -C packages/sdk-go mod download
go -C packages/sdk-go/internal/generator mod download
```

The existing `just install` recipe runs those installations. Copy `.env.example` to `.env` only when a model-backed or cloud-browser run needs credentials. Never commit an `.env` file, browser profile, session state, or real key.

## Before a pull request

Start with the affected package's offline checks. For changes to shared contracts, build the protocol and extension before the SDKs:

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
```

`pnpm check`, `just check`, and `just test` cover broader validation when the relevant toolchains and network access for documentation links are available. Browser-backed tests and evaluations can require credentials and external services; label any skipped checks in the pull request. Include the smallest regression test that demonstrates a behavior change.

Do not run inherited release, publish, preview-deployment, or credentialed evaluation recipes as part of ordinary validation. Release workflows from upstream are archived for reference; BrowseActra does not have an automatic publishing process.

## Changesets and releases

The repository includes upstream Changesets metadata and release scripts. They reflect the original SDK package identities and versions and are not evidence of a BrowseActra package release. Do not publish `@browserbasehq/stagehand`, `stagehand` on PyPI, or the existing Go module from this repository without a separately reviewed ownership, naming, and release plan.

The root [CHANGELOG.md](CHANGELOG.md) distinguishes BrowseActra's repository migration from Stagehand's historical entries. Preserve upstream license notices and attribution in any derivative or substantial copy of this software.
