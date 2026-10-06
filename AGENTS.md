# Repository guidance

This private repository owns `@knights-eye-chess/ai-analysis` source. Read README.md and SOURCE-ORIGIN.json before changing code. The source originated in the preserved Shedal/KnightsEye backup; future changes belong here.

Use Node 24+, npm ci, npm run check and npm run pack:checked. Internal source-build dependencies use hash-pinned local archives and the lockfile; the pack helper emits exact version dependencies. Never overwrite committed archives with different bytes at the same filename/version. Bump the version for a new artifact.

Keep this repository private. Public publishing, licensing, support commitments and automatic CI require a separate owner decision. The manual workflow does not deploy websites. Do not alter classifier semantics or host UI behavior as part of a structural cleanup.
