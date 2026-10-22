# Local HTTP API

The first BrowseActra API is implemented in `apps/api/src/server.ts`. It binds to `127.0.0.1:3000` by default, serves the web console at `/`, and exposes versioned JSON routes. The API is intended for local development unless explicitly configured and secured for another network.

## Authentication and errors

If `BROWSEACTRA_API_KEY` is configured, every `/api/v1/*` request needs `Authorization: Bearer <key>`. Every browser job requires its target host in the operator's `BROWSEACTRA_ALLOWED_HOSTS` allowlist. Binding to a non-loopback address also requires a key of at least 24 characters. The `/health`, `/ready`, and static UI routes are unauthenticated. CORS is same-origin by default; configured exact origins can be allowed.

Errors use `{ "error": { "code": "...", "message": "..." } }` with an appropriate HTTP status. Bodies above 64 KiB are rejected. Requests are rate-limited per remote IP in the process; this is a basic local safeguard, not a complete public-edge protection layer.

## Jobs

| Method | Path                              | Response                                                                |
| ------ | --------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/v1/jobs`                    | `202 {"job": ...}` for a new job; `200` for a matching idempotency key. |
| `GET`  | `/api/v1/jobs?limit=50`           | `{ "jobs": [...] }`; `limit` is 0–100.                                  |
| `GET`  | `/api/v1/jobs/:id`                | `{ "job": ... }`.                                                       |
| `POST` | `/api/v1/jobs/:id/cancel`         | `{ "job": ... }` with updated status.                                   |
| `GET`  | `/api/v1/jobs/:id/events?after=0` | `{ "events": [...] }` ordered by event ID.                              |
| `GET`  | `/api/v1/jobs/:id/receipts`       | `{ "receipts": [...] }` with verification status and bounded metadata.  |
| `GET`  | `/health`                         | `{ "status": "ok" }`.                                                   |
| `GET`  | `/ready`                          | `{ "status": "ready" }` when the database responds.                     |

Send JSON with an `instruction` of 1–4000 characters and an HTTP(S) `url` of at most 2048 characters. Embedded URL credentials are refused. Configure `BROWSEACTRA_ALLOWED_HOSTS=example.com` on the API before the following request. The optional `Idempotency-Key` header accepts 1–128 letters, digits, `.`, `_`, `:`, or `-`. The same key with a different instruction or URL returns `409`.

```sh
curl -sS -X POST http://127.0.0.1:3000/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-title-1' \
  -d '{"instruction":"Read the page title","url":"https://example.com"}'
```

When a key is configured, add `-H "Authorization: Bearer $BROWSEACTRA_API_KEY"`. Do not place a real key in shell history or committed examples.

A job includes `id`, `instruction`, `url`, `status`, timestamps, `result`, `error`, and `attempt`. Statuses are `queued`, `running`, `cancel_requested`, `completed`, `failed`, `cancelled`, or `indeterminate`. A completed status means the worker committed an outcome; inspect receipts to see whether individual actions were independently verified.

## Live events

`GET /api/v1/jobs/:id/events` returns JSON by default. Send `Accept: text/event-stream` to receive Server-Sent Events. Each event carries an event ID, type, timestamp, job ID, and bounded data. The stream closes after a terminal job status. Clients with bearer authentication can use `fetch()` streaming; native `EventSource` cannot set an Authorization header. The bundled web console polls the JSON endpoint so it works in both authentication modes.

## Current scope

The API accepts one instruction and starting URL per job, plus an optional flat object `outputSchema` with string, number, or boolean fields. It does not yet accept a general workflow graph or arbitrary browser commands. Schema conformance is checked separately from grounding the output in browser observations. Results depend on the configured provider and action policy. See [system design](SYSTEM_DESIGN.md) and [security](SECURITY.md).
