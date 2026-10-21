# Initial migration validation

Checks were run on 2026-10-22. The supplied source was an extracted ZIP without Git history. A clean shallow clone of Stagehand commit `d16562dafc402893a65e0fe83e16eacddacb4c58` matched every untouched source file, generated protocol file, lockfile, and required license.

## Toolchain

- pnpm 11.25.0 used managed Node.js 24.21.0. The root manifest declares pnpm 11.11.0 and Node.js ^24.18.0 for development.
- The Python SDK used CPython 3.11.17 managed by uv 0.13.4. Its manifest requires Python >=3.11.
- Go 1.26.5 satisfied the Go 1.26.0 module directive.

## Passed checks

- `pnpm install --frozen-lockfile` installed all 28 workspaces. `CI=true pnpm install --frozen-lockfile` also passed after metadata changes. Install warnings concerned integration CLI bins that require their own builds.
- `pnpm --dir packages/protocol build`, `pnpm --dir packages/extension build`, `pnpm --dir packages/sdk-ts build`, and `CI=true pnpm --dir packages/cli build` passed. The SDK's publint step found no issues.
- `pnpm --dir packages/protocol test:unit`: 589 passed across 25 files.
- `pnpm --dir packages/extension test:unit`: 1,054 passed and 9 upstream todo across 68 files.
- `pnpm --dir packages/sdk-ts test:unit`: 579 passed across 28 files.
- `CI=true pnpm --dir packages/cli exec vitest run tests/cli-telemetry.test.ts`: 15 passed, including the new default-off analytics test.
- `CI=true pnpm --dir packages/cli exec vitest run tests/cli-command-not-found.integration.test.ts tests/cli-telemetry.test.ts`: 20 passed across the two affected CLI suites.
- `pnpm --dir packages/protocol typecheck`, `pnpm --dir packages/extension typecheck`, `pnpm --dir packages/sdk-ts typecheck`, and `CI=true pnpm --dir packages/cli check` passed.
- `CI=true pnpm lint` passed with inherited warnings. `CI=true pnpm fmt:check` passed.
- `uv --directory packages/sdk-python run --locked pytest tests --ignore=tests/test_browserbase_routing_live.py`: 1,052 passed, 1 skipped.
- `uv --directory packages/sdk-python run --locked ruff check src tests scripts` and `uv --directory packages/sdk-python run --locked ty check src` passed.
- `pnpm --filter ./packages/docs test:unit`: 45 passed.
- `CI=true pnpm --filter ./packages/docs check` passed with network access: Mint validation, broken links, and accessibility across 156 MDX files.
- Selected Go RPC and response unit tests passed:

```sh
go -C packages/sdk-go test . -run '^(TestResponse|TestRPC)'
```

## Known limitations and earlier failures

- The wider Go command below failed because the unchanged upstream `examples` package contains multiple standalone `main` programs in one directory. The SDK root and internal packages passed.

```sh
go -C packages/sdk-go test ./... -run '^(TestResponse|TestRPC)'
```

- The first extension unit run failed when the restricted shell denied localhost `listen` with `EPERM`; it passed with localhost access. The first TypeScript SDK unit run was interrupted in that restricted environment and passed on rerun.
- An initial docs check hit a `p-cancelable`/`got` exception under restricted network access; the full docs check passed with network access.
- A broad `ruff check .` accidentally included the installed `.venv` and found third-party lint errors. The project-source command above passed.
- One `CI=true pnpm check` run raced root formatting against protocol schema generation, while a restricted-network run failed in Mint. The sequential protocol build, standalone format check, core typechecks, and full docs check passed. The active CI uses those validated sequential commands.
- Browser-backed, credentialed, model, cloud, and paid evaluation suites were not run.

## Security and publication gate

Gitleaks 8.30.1 scanned the import with redacted reports. An embedded upstream CLI analytics token was removed. The final scan reports 13 `generic-api-key` heuristic matches, all within upstream test fixtures and `.env.example` placeholders; no credential-bearing application source remains. No real `.env`, key, certificate, or database file was found. The ZIP had no history to scan. The sole active workflow has read-only repository permissions and no publish, deployment, release, or credentialed step. Inherited workflows are archived outside `.github/workflows/`.
