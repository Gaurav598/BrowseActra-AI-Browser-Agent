# Testing

BrowseActra's new application tests are separate from the imported SDK baseline. Run the project-owned checks first, then retained-package checks when changing inherited code.

## Fast checks

```sh
node scripts/brand-check.mjs
pnpm build:browseactra
pnpm typecheck:browseactra
pnpm test:browseactra
```

These commands should be run after `pnpm install --frozen-lockfile`. A passing typecheck or unit suite does not prove a browser launched; use the local integration path below for that.

## Browser integration

Browser tests should use deterministic local HTML fixtures and a real Chromium process. They must not require paid model calls, hosted browsers, or credentials. Use a deterministic provider for the normal CI path. Assert observable page state and action receipts, then confirm the browser context and process are closed.

The implemented end-to-end script starts a local fixture and the API/worker, submits real browser jobs through the API, SDK, and CLI, checks a persisted navigation receipt and structured output, confirms the UI is served, and checks that an unsupported action request fails closed. A second deterministic provider performs a real allowed click, observes the changed DOM, and verifies that the click receipt and resulting text were persisted:

```sh
pnpm --dir packages/browseactra-runtime exec playwright install chromium
pnpm exec tsx tests/e2e/local-browser.ts
```

On macOS with installed Chrome, `BROWSEACTRA_BROWSER_CHANNEL=chrome` uses that browser without downloading Playwright Chromium. Worker/store unit tests cover expired leases and ambiguous completion after interruption. The end-to-end script does not yet inject a real browser crash between an external side effect and receipt commit.

For a manual smoke test, start the API in one terminal and use the CLI in another:

```sh
pnpm --dir apps/api dev
pnpm browseactra run "Read the page title" --url https://example.com
```

This live command needs an installed browser. The no-key provider handles the title instruction; the example accesses the network. Use `docs/fixtures/demo.html` for an offline fixture.

## Fault and security cases

The worker/store tests cover duplicate idempotency keys, concurrent claims, stale fencing tokens, lease expiry, worker restart marking uncertain jobs `indeterminate`, cancellation, and safe failure classification. Agent and verifier tests cover invalid model output, denied actions, missing postconditions, and redaction. Browser tests cover target restrictions and process cleanup. DNS rebinding, richer postcondition predicates, and crash injection at the action/receipt boundary remain open security and reliability work.

## Results and limits

The [initial migration validation](MIGRATION_VALIDATION.md) records checks of the Stagehand-derived source before the new application work. It is not a test report for BrowseActra's new modules. The final engineering report records the new suite results and browser prerequisites.
