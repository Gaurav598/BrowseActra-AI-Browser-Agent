# Local development

## Prerequisites

Use Node.js 24.18 or later and pnpm. The imported workspace declares pnpm 11.11.0; keep the frozen lockfile when installing. Install a compatible Chromium browser for local execution. The BrowseActra runtime uses the repository's pinned Playwright package; install its Chromium browser with Playwright's installer if it is not already present. Python 3 is used only for the simple local fixture server below.

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/browseactra-runtime exec playwright install chromium
pnpm build:browseactra
```

The second command downloads a browser binary. It is needed for real browser jobs, not for pure unit tests. If your system uses an existing Chrome binary, use the configured executable path supported by the runtime.

## Start the local application

From the repository root:

```sh
pnpm --dir apps/api dev
```

The API serves the UI at `http://127.0.0.1:3000/` and runs a bounded worker in the same process. Its SQLite state defaults to `apps/api/data/browseactra.db` when started with this command. Use `Ctrl-C` to stop it; interrupted work may be marked `indeterminate` because the browser side effect cannot be inferred from a process exit.

The CLI provides the same development entry point and job commands:

```sh
pnpm browseactra --help
pnpm browseactra dev
pnpm browseactra run "Read the page title" --url https://example.com
```

Run `dev` in one terminal with `BROWSEACTRA_ALLOWED_HOSTS=example.com`, then `run` in another. The API refuses every target without an operator host allowlist. The no-key provider accepts `Read the page title` and `Read the page text`. For a network-free page after browser installation, start the fixture and allow its loopback host:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs/fixtures
BROWSEACTRA_ALLOWED_HOSTS=127.0.0.1 pnpm --dir apps/api dev
pnpm browseactra run "Read the page title" \
  --url http://127.0.0.1:4173/demo.html
```

Run the three lines in separate terminals as needed. Use the browser console at `/` to submit, monitor, and cancel jobs. The web console reads actual API state; it contains no simulated job results.

## Configuration

The local server binds to loopback by default. Configuration is read by `apps/api/src/main.ts`:

| Variable                                                             | Purpose                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSEACTRA_HOST`, `BROWSEACTRA_PORT`                               | Bind address and port; defaults `127.0.0.1:3000`.                                                                                                                         |
| `BROWSEACTRA_DATABASE_PATH`                                          | SQLite file; defaults `./data/browseactra.db` relative to `apps/api`.                                                                                                     |
| `BROWSEACTRA_ALLOWED_HOSTS`                                          | Comma-separated trusted target host allowlist; required for every API browser job.                                                                                        |
| `BROWSEACTRA_API_KEY`                                                | Optional bearer key on loopback; required for non-loopback bind.                                                                                                          |
| `BROWSEACTRA_ALLOWED_ORIGINS`                                        | Optional exact CORS origins for a separate client.                                                                                                                        |
| `BROWSEACTRA_MAX_CONCURRENT`                                         | Local worker capacity; defaults to 2.                                                                                                                                     |
| `BROWSEACTRA_MODEL_API_KEY`, `BROWSEACTRA_MODEL_NAME`                | Enable a configured OpenAI-compatible provider instead of the narrow local interpreter.                                                                                   |
| `BROWSEACTRA_MODEL_BASE_URL`                                         | Optional compatible model endpoint.                                                                                                                                       |
| `BROWSEACTRA_BROWSER_CHANNEL`, `BROWSEACTRA_BROWSER_EXECUTABLE_PATH` | Select Chrome/Chromium or an installed browser binary.                                                                                                                    |
| `BROWSEACTRA_ALLOW_MUTATIONS`                                        | Must be `true` before any click/fill/select can run; default is false.                                                                                                    |
| `BROWSEACTRA_APPROVED_MUTATIONS`                                     | JSON array of exact trusted approvals, for example `[{"host":"example.com","type":"click","selector":"#confirm"}]`. Each mutation also needs an observable postcondition. |

The API refuses a non-loopback bind without an API key and target-host allowlist. Use environment variables rather than source files for keys. Model calls can incur charges.

The imported `.env.example` also includes keys for legacy Stagehand integrations. Those are not required for the project-owned local browser path. Do not commit `.env`, browser profiles, or SQLite job files.

## Development checks

```sh
node scripts/brand-check.mjs
pnpm --dir packages/browseactra-runtime typecheck
pnpm --dir packages/browseactra-verifier typecheck
pnpm --dir apps/api typecheck
pnpm --dir packages/browseactra-sdk typecheck
pnpm --dir packages/browseactra-runtime test
pnpm --dir packages/browseactra-verifier test
pnpm --dir apps/api test
pnpm --dir packages/browseactra-sdk test
```

The existing protocol, extension, and SDK checks remain useful for retained source, but they validate the imported compatibility path, not the new BrowseActra application. See [testing](TESTING.md) for coverage and [UPSTREAM.md](../UPSTREAM.md) for attribution.
