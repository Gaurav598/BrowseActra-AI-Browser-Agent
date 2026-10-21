# Upstream source and attribution

BrowseActra is an independently maintained project derived from the open-source **Stagehand** repository. The imported implementation was created and maintained by **Browserbase Inc.** and its contributors. BrowseActra does not claim original authorship of that implementation, nor affiliation with or endorsement by Browserbase.

| Item                      | Imported source                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Original project          | Stagehand                                                                                                                              |
| Original maintainer       | Browserbase Inc. and contributors                                                                                                      |
| Original repository       | <https://github.com/browserbase/stagehand>                                                                                             |
| License                   | MIT; see [`LICENSE`](LICENSE) and [`packages/cli/LICENSE`](packages/cli/LICENSE)                                                       |
| Original copyright notice | `Copyright (c) 2024 Browserbase Inc.`                                                                                                  |
| Source form               | Extracted source tree without its `.git` directory or commit history                                                                   |
| Exact imported revision   | [`d16562dafc402893a65e0fe83e16eacddacb4c58`](https://github.com/browserbase/stagehand/commit/d16562dafc402893a65e0fe83e16eacddacb4c58) |

The import includes the shared protocol, Chrome extension runtime, TypeScript/Python/Go SDKs, CLI, integrations, evaluations, examples, docs, and upstream release history. Existing `Stagehand`, `stagehand`, `@browserbasehq/`, and Go module identifiers remain where changing them would break imports, generated code, or external compatibility. Browserbase-specific service references remain where they identify an actual dependency or integration.

The root and CLI MIT license texts preserve the original copyright and permission notices. Third-party dependencies retain their own licenses. The historical upstream changelog entries in [`CHANGELOG.md`](CHANGELOG.md) are clearly identified as Stagehand history, not BrowseActra releases.

BrowseActra's initial repository migration adds project-owned presentation, documentation, provenance, and repository safety configuration. Substantial BrowseActra-specific backend and distributed-systems features are planned in [`docs/ENGINEERING_ROADMAP.md`](docs/ENGINEERING_ROADMAP.md); the roadmap is not a claim that those features exist today.

The revision was verified on 2026-10-22 by shallow-cloning the upstream repository at that commit and running a recursive file comparison against the supplied source tree. Every differing or added path corresponded to the BrowseActra migration edits; all untouched source, lockfiles, generated protocol files, and license texts matched. The supplied tree itself had no Git metadata, so historical commits and authors could not be imported into the new repository.
