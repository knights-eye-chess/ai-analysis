# Preparing an npm release

This is publication preparation only. No npm publication or repository visibility change has been performed. First-party licensing is recorded in [LICENSING.md](LICENSING.md); publication remains a separate owner decision.

## Prepare and inspect

Use Node 24+ and npm 11+ from this source checkout:

```sh
npm ci
npm run publish:prepare
```

This builds and runs the existing package checks, writes `artifacts/knights-eye-chess-ai-analysis-0.1.0-dev.12.tgz`, validates its runtime/type exports, assets, CLI paths and license files, then runs `npm publish --dry-run` against the archive. It does not write to a registry. `npm run pack:artifact -- /absolute/output-directory` stages an archive after a build; `npm run publish:verify -- /absolute/output-directory/knights-eye-chess-ai-analysis-0.1.0-dev.12.tgz` validates an external archive.

The source manifest keeps `private: true` to block accidental publication from the repository root. The staged consumer manifest omits `private` and sets `publishConfig` to public access, `https://registry.npmjs.org/` and the `next` prerelease tag. Preparation uses the staged tarball; bare `npm pack` retains the private source manifest and is not a release artifact.

The source lockfile and `vendor/npm` archives remain the pinned, immutable build inputs. Reviewed [npm-release.json](npm-release.json) maps source `file:` dependencies to exact coordinated registry versions. The consumer tarball excludes `npm-shrinkwrap.json` and vendor archives so local source pins cannot override registry dependencies. It includes source/build files, declarations and licenses. For source rebuilds from a tarball, use `npm install --ignore-scripts` after the required sibling versions are available, then `npm run check`; a reproducible `npm ci` build uses the checkout and its source lockfile. Board UI's GPL demo examples are separate from the npm library artifact.

Archive filenames are immutable: the helper accepts identical bytes at an existing destination and rejects different bytes. Bump the package version (including the lockfile root), review dependent registry versions and create a new filename whenever source, documentation or packaging changes. Historical archives are never replaced.

## Qualify the coordinated candidates

These sibling versions are not assumed to exist on npm. Prepare each repository, then install all six candidate archives together in an independent consumer directory, outside every source checkout:

```sh
mkdir -p /tmp/knights-eye-release-consumer
cd /tmp/knights-eye-release-consumer
npm init -y
npm install --ignore-scripts --no-audit --no-fund \
  /workspace/board-ui/artifacts/knights-eye-chess-board-ui-0.1.0-dev.29.tgz \
  /workspace/game-tree/artifacts/knights-eye-chess-game-tree-0.1.0-dev.6.tgz \
  /workspace/move-classifier/artifacts/knights-eye-chess-move-classifier-0.1.0-dev.8.tgz \
  /workspace/pgn-annotator/artifacts/knights-eye-chess-pgn-annotator-0.1.0-dev.11.tgz \
  /workspace/ai-analysis/artifacts/knights-eye-chess-ai-analysis-0.1.0-dev.12.tgz \
  /workspace/cli-tools/artifacts/knights-eye-chess-cli-tools-0.1.0-dev.14.tgz
npx --no-install knights-eye-annotate --help
npx --no-install knights-eye-answer --help
```

Run the installed library public imports, a strict TypeScript NodeNext consumer and the existing independent package tests before release. Browser consumers cover Board UI, game-tree and move-classifier; engine/CLI hosts in pgn-annotator and cli-tools require Node. No CommonJS `require` entry point is advertised. AI analysis uses neutral ESM with external AI SDK dependencies; browser compatibility depends on the host and selected provider transport. Engine binaries, credentials and successful live model answers are not supplied or certified by a package check.

`.github/workflows/npm-prepare.yml` is manual (`workflow_dispatch`) and runs the same preparation checks with read-only repository permissions. It uploads candidate archives for review; it contains no real publish step, registry token, OIDC permission or automatic release trigger. It does not perform the combined six-package install, which must be qualified separately while sibling packages are unpublished.

## Owner prerequisites for a future publication

The npm organization `knights-eye-chess` must exist and the publishing account must have authority for every intended scoped package. Confirm each name/version is available, organization/team package access, authentication and the organization's 2FA requirements. GitHub repository access is independent of npm publishing authority. Authenticate through npm's supported login or secure CI secret settings; never put credentials in this checkout or a chat message.

The first release order is:

1. Board UI, game-tree and move-classifier can be released independently of sibling packages; release ai-analysis after its exact move-classifier version is available.
2. Release pgn-annotator after its exact move-classifier version is available.
3. Release cli-tools after its exact move-classifier, pgn-annotator and ai-analysis versions are available.

All candidates are prereleases: use `next`, preserve `latest`, and use public scoped access explicitly. After the owner authorizes a real release, authenticate with an account authorized for the scope and publish the reviewed tarball (never the source root):

```sh
npm whoami --registry https://registry.npmjs.org/
npm view @knights-eye-chess/ai-analysis@0.1.0-dev.12 version --registry https://registry.npmjs.org/
npm publish artifacts/knights-eye-chess-ai-analysis-0.1.0-dev.12.tgz --dry-run --ignore-scripts --access public --tag next --registry https://registry.npmjs.org/
# Only after separate release authorization:
npm publish artifacts/knights-eye-chess-ai-analysis-0.1.0-dev.12.tgz --ignore-scripts --access public --tag next --registry https://registry.npmjs.org/
```

An `npm view` 404 indicates that exact version is not visible; it does not establish ownership of the scope. Check the published version's exports/files and install it from the registry afterward. Record the artifact integrity and resulting package URL in the release issue.

For future trusted publishing, configure each npm package's trusted publisher to an exact repository, workflow filename and (if used) protected GitHub environment. Adopt supported Node/npm versions, grant `id-token: write` only to an explicitly approved publishing job and use provenance where the npm/GitHub repository visibility combination supports it. Bootstrap/package ownership and private-repository provenance constraints must be checked with npm before adding that job. The preparation workflow deliberately has no active publishing credential or trusted-publisher configuration.
