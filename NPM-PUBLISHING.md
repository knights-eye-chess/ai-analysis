# Publishing @knights-eye-chess/ai-analysis

The owner authorized public npm prereleases on 10 October 2026. Use **`next`** and preserve any existing `latest` tag. Licensing is documented in [LICENSING.md](LICENSING.md).

## Prepare the exact candidate

Use Node 24 and npm 11:

```sh
npm ci
npm run publish:prepare
```

Review `artifacts/knights-eye-chess-ai-analysis-0.1.0-dev.13.tgz`, including its files, exports, declarations, licenses and exact registry dependencies. Reusable source and offline owner tests are intentional; application traces, credentials, vendor archives and source lockfiles are excluded. The checkout stays `private: true`; publish only the staged archive. Archive contents are immutable: use a new version for changed bytes.

Before every coordinated release, run `node tools/release-tooling/sync.mjs --check` in the reviewed app checkout alongside all six component revisions. Record those commits and the result.

## Publish through GitHub Actions

Manually dispatch **Publish reviewed npm candidate** on `dev` with the exact version and reviewed archive SHA-256. It requires a public component repository, runs clean installation and package checks, and refuses a different archive hash. `NPM_TOKEN` is supplied only to the publication step; GitHub OIDC supplies provenance. An already-published version is accepted only if its integrity matches.

Release Board UI, Game Tree and Move Classifier first; AI Analysis and PGN Annotator after Classifier; CLI Tools after its dependencies. Bootstrap source checkouts temporarily retain qualified local inputs until the sibling versions exist; staged consumer manifests already use exact npmjs versions. After registry integrity is verified, switch source manifests and locks to the registry and qualify clean installs.

Verify public imports, types and consumer examples after publication. No engine executable, provider credential, live AI answer or support guarantee is included. Automatic publication and future trusted-publisher configuration remain separate changes.
