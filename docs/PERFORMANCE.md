# Performance and benchmark status

BrowseActra does not claim a measured speedup over the imported Stagehand foundation or another browser framework. No production throughput or latency service-level objective has been established.

## Local fixture measurement

On 2026-10-22, `BROWSEACTRA_BROWSER_CHANNEL=chrome node_modules/.bin/tsx tests/performance/local-benchmark.ts` completed five sequential jobs against a loopback HTML fixture with a fresh temporary SQLite database. The deterministic provider read the fixture title; each job launched an isolated local Chrome session. The machine ran macOS on arm64, Node.js 24.21.0, and Google Chrome 156.0.8078.47. The exact hardware model was unavailable to the sandbox.

| Metric                       |          Result |
| ---------------------------- | --------------: |
| End-to-end latency p50 / p95 | 414 ms / 594 ms |
| Observed latency range       |      365–594 ms |
| Queue wait p50 / p95         |     0 ms / 3 ms |
| Verified action receipts     |           5 / 5 |
| Failed jobs                  |           0 / 5 |

This is a five-sample local smoke benchmark, not a throughput study or production service-level objective. It excludes model calls, network latency, and concurrent load; timings include API submission, worker claim, browser launch, navigation, verification, and polling. Re-run the script on the target machine before using the numbers for capacity planning.

## Measurements to collect

For a repeatable local browser scenario, record browser startup latency, queue wait, action latency, verification latency, end-to-end job latency, and peak memory. Report p50 and p95 only with the sample count, hardware, operating system, Node and Chromium versions, provider type, dataset revision, and failure count. Separate deterministic provider runs from paid-model runs.

The next benchmark should vary concurrency and include deliberately failed actions, browser crashes, and a larger sample count. It should report verified and indeterminate rates. A comparison to upstream requires the same browser, machine, tasks, and repeat count against the verified imported revision.

## Current evidence

Unit, integration, and browser test results belong in [testing](TESTING.md) and the final engineering report. Passing tests and this small benchmark demonstrate behavior under their fixtures; they do not establish production latency, recovery rate, or model cost.
