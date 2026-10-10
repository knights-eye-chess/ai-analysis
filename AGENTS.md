# Repository guidance

This repository owns `@knights-eye-chess/ai-analysis` source. Read [README.md](README.md) and [SOURCE-ORIGIN.json](SOURCE-ORIGIN.json) before changing code. The origin record preserves the historical extraction snapshot; maintained source and future changes belong in [this component repository](https://github.com/knights-eye-chess/ai-analysis).

Use Node 24+, npm ci, npm run check and npm run pack:checked. Source builds use exact registry dependencies and the lockfile after coordinated bootstrap. Historical archives stay immutable; the pack helper also accepts legacy archived inputs. Never overwrite committed archives with different bytes at the same filename/version. Bump the version for a new artifact.

The owner authorized public visibility and manual npm prerelease publication on 2026-10-10. Preserve approved licensing. Support commitments and automatic publication require a separate decision. The manual workflow does not deploy websites. Do not alter classifier semantics or host UI behavior as part of a structural cleanup.

## Approved licensing decision (2026-10-08)

The owner approved AGPL-3.0-or-later for first-party code. See LICENSING.md. This supersedes earlier statements that a license has not been selected. Preserve third-party notices and immutable historical archives. Public registry publication, repository visibility and support commitments remain separate owner decisions.
