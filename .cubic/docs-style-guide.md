# BrowseActra product documentation guide

Review newly added or modified project-owned documentation and UI copy for accuracy and clarity. This guide applies to `README.md`, `docs/**`, and `apps/web/**`; it does not govern historical upstream files.

## Factual claims

- Describe implemented behavior from the current code and tests. Label proposed features as planned.
- Distinguish BrowseActra-owned components from retained Stagehand-derived code. Do not claim inherited code was independently authored.
- Do not imply Browserbase affiliation or endorsement. Keep required MIT notices and factual provenance intact.
- Give executable commands and examples that match current package manifests and endpoints.
- Do not present mock or deterministic test output as a live model or browser result.

## Product language

- Call the current product **BrowseActra**. Use `BrowseActra` for classes and `browseactra` for commands only when those interfaces exist.
- Existing third-party names belong in provenance, dependency explanations, and compatibility notes, not in BrowseActra's title, navigation, support links, or calls to action.
- Use one main idea per paragraph, direct verbs, and precise failure conditions. Avoid unsupported claims about reliability, speed, cost, or security.
- Show the normal local path first, then optional model or cloud services and their prerequisites.

## Review comments

Report an actionable issue with the exact file and a proposed correction. Do not block a focused change for untouched historical content.
