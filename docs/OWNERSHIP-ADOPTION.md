# AI owner consolidation, 10 October 2026

`OWNERSHIP-DRIFT.json` records SHA-256 hashes before deletion for all eight
non-identical app/component modules. The app installed `0.1.0-dev.9`; every one
of those eight installed source files equals component source `0.1.0-dev.11`.
Thus source dev11's newer behavior was already the application's shipped
controlled answer pipeline. It is retained deliberately:

| Module | Adoption |
| --- | --- |
| answer-pipeline | Intentional ed04bb0 phase timing and be9eedd cancellation-safe opt-in parallel preparation retained; both already shipped in installed dev9. |
| opponent-threat-preparation | Intentional fea48a8 search outcome accounting and be9eedd opt-in concurrency retained. |
| poc-contracts | Intentional fea48a8 actual analyzer-outcome callback retained. |
| poc-tools | Intentional fea48a8 completed search-outcome accounting retained. |
| portable-answer-runtime | Intentional fea48a8 outage disclosure and 610a27d preserved final reference ranges retained. |
| simple-evidence-preparation | Intentional fea48a8 failure causes and outcome counts retained. |
| server-simple-policy | Adopt intentional 610a27d issue #7 correction: both descriptions explicitly require analyzeFinal=true for compareFinalMovesUci. The app retained source missed that migration; no old-wording override remains. System text is unchanged. |
| simple-prose-references | Upstream intentional app ed87585 / 347f478 / 89cce23 v22 changes: fresh same-answer PV admission and structured gap counts. Their legality/provenance gates and stored-answer version remain intact. |

The fresh-engine-pv-witnesses validator now belongs here with prose references.
The app's 91 maintained copies (87 reasoning modules and four identical pure top-level helpers) were removed after replacing consumers with
installed root/research exports. Host adapters, deployment policy variants,
node/browser providers and active historical research runners remain in the app.
Their versioned evidence and archived source snapshots were not rewritten.

Classifier version and scoped decision validation are imported from the
classifier's public `/contracts` entry; this repository no longer owns a second
classifier-rules or classifier-decision runtime. The dependency is a hash-pinned
local source-build archive and the packed release names its exact public version.

No widget source fragment or fingerprint, real model run, registry publication,
commit or push is part of this consolidation. Package checks validate offline
protocol and evidence behavior, not model answer quality.

The four identical helpers ai-request-failure, ai-request-limits, ai-routing-diagnostics and player-perspective were extracted in bc8f5f2. Their maintained component source now serves all hosts via `/shared`. This entry also provides pure context, reference, recorded-view and routing helpers. Its runtime closure imports only chess.js; the build rejects model SDK or classifier runtime imports. Workspace browser presentation/protocol/client entries use `/shared`, while website browser execution intentionally loads the root pipeline in its execution adapter outside those entries.
