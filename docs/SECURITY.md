# Security boundaries

BrowseActra executes browser actions against external websites. A page can contain malicious instructions, credentials, or personal data. The project-owned local application treats page content as untrusted input; it is not an authority for tool permissions.

## Current controls

- The API binds to loopback by default. Non-loopback bind requires a bearer key of at least 24 characters and an explicit target-host allowlist.
- JSON request bodies are bounded; URLs must be HTTP(S) without embedded credentials. The API requires an explicit operator host allowlist for every browser target, including public hosts. The browser layer checks routed requests against its target policy.
- API CORS permits same-origin or explicitly configured exact origins. Static UI responses set a restrictive Content Security Policy. The UI inserts API data as text, not HTML, and keeps an entered API key in memory only.
- The agent accepts typed model decisions, applies a trusted action policy, and does not allow webpage text or model output to authorize a sensitive action. Default actions are limited to read-oriented navigation and text inspection.
- Mutations need both an enable flag and an exact host/type/selector allowlist entry supplied by the operator. A verified mutation receipt requires an observed false-to-true postcondition change; an already true or unreadable baseline is indeterminate. A model's finish claim is independently grounded in observed title, text, URL, or verified text results.
- Browser observations are bounded. Job events and receipts are size-limited and redact common secret field names and token patterns before persistence.
- Worker leases and fencing tokens stop stale owners from writing results. Ambiguous execution is marked `indeterminate` rather than automatically retried.

These controls are implementation-specific; consult `apps/api/src/server.ts`, `apps/api/src/store.ts`, and `packages/browseactra-runtime/src/browser.ts` for exact behavior.

## Known limitations

- Hostname checks alone do not provide a complete DNS rebinding defense. Network-layer egress controls are needed before exposing the service to untrusted users or targets.
- The current local SQLite store and per-IP in-process rate limiter are not a multi-tenant security boundary. Authentication is optional on loopback.
- Model providers receive task goals and bounded page observations. Do not enter secrets or sensitive page data unless the configured provider and data policy allow it.
- Redaction catches known patterns and field names but cannot prove that every secret in arbitrary page text is removed. Avoid persisting raw pages, screenshots, or sensitive results without a reviewed retention policy.
- The browser is local. A website may attempt downloads, redirects, cross-origin requests, or prompt injection; keep browser and Playwright patched and run jobs with least-privilege OS permissions.
- Verification receipts report observed conditions, not a guarantee that a remote transaction is reversible or permanently committed.
- The finish verifier intentionally rejects derived model summaries and ungrounded values. It proves exact observation matches, not semantic correctness of arbitrary model output. Human approval, site-specific guards, and reconciliation are still needed for high-impact browser actions.

## Deployment posture

The supported first-run posture is a local developer service. Do not expose the API directly to the public internet. Production deployment requires an external authentication and network boundary, strong secret management, hardened browser sandboxing, monitored data retention, DNS-aware egress policy, and operational review. No inherited Browserbase credentials or publishing workflow are needed for the normal BrowseActra local path.

Report suspected security issues through the repository owner rather than including live credentials in public issues.
