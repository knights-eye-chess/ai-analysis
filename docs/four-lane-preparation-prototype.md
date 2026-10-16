# Four-lane initial preparation prototype (#85)

This is an unadopted Dev candidate. The qualified engine-only study (run
38842314204) made four independent one-thread chains eligible for implementation;
it did not measure application answer latency or qualify model output.

## Boundary

`runAnswerPipeline` accepts `initialSearchConcurrency: 4` and a dedicated
`initialPreparationAnalyzer`. Both are fixed in the answer's input snapshot.
Only full-game plans with `reviewScope` and exclusively recorded-position
requests use the opt-in. Other plans and all callers without the opt-in retain
serial acquisition. Four-lane full-game acquisition rejects a missing dedicated
provider rather than silently sharing the normal analyzer.

The host must supply an answer-isolated independent one-thread provider backed
by at most four simultaneous processes. Four scheduler lanes each execute one
recorded tool request at a time; any continuation/repair searches inside that
tool remain serial under the existing tool implementation. No general model-tool
concurrency or provider default has changed. Normal model tools use the normal
host/analyzer after preparation drains. The application wiring and exact package
release/adoption are separate changes; this prototype does not publish anything.

The current application addresses `AI_ENGINE.getByName('answer:' + job.id)`.
Two distinct answer jobs therefore address distinct Durable Object/container
identities, each with its own allocation; they do not inherently share one
four-vCPU container. This prototype introduces no cross-job global queue.
Mock tests establish independent provider/state scopes, not platform quota,
billing, aggregate capacity, or real simultaneous-user latency.

## Scheduling and compatibility

Each discovery enables at most its existing dynamically derived matched
comparison, using `preparedMoveComparison` unchanged. That comparison starts
within its chain as soon as the discovery is admitted. There are at most four
active chains. A failed discovery produces one failed record and no comparison;
ordinary search errors do not cancel unrelated chains or trigger retries.

The serial default preserves historical `initial-search-N` call IDs. Only the
explicit opt-in uses `initial-chain-N-discovery` / `initial-chain-N-comparison`.
This is an intentional trace/evidence identifier compatibility difference:
consecutive historical IDs depend on dynamically inserted comparisons and cannot
be assigned by concurrent completion order. Results, attribution lookup,
consolidation and evidence publication are committed in logical chain order.
The same inputs and mock results produce the same ordered requests and dynamic
root sets as serial execution. This does not promise identical real-engine
scores/PVs across changed thread/process histories.

Requests are cloned before concurrent dispatch. Existing depth, root selection,
PV completion, legality, score provenance, license and context checks remain.
No raw benchmark result is substituted for complete application tool evidence.
The normal model barrier remains after all preparation and consolidation.

Parent cancellation prevents further dispatch and drains every active chain,
including providers finishing delayed cleanup. A soft deadline stops new work;
already admitted calls finish, and unstarted discoveries or derived comparisons
are counted as deferred. Unknown comparisons for unstarted discoveries are not
invented or counted. Search failures and deferred work remain distinct.

## Release compatibility notes

Branch-expansion routing recognizes both historical serial IDs and the opt-in
chain discovery/comparison IDs as preparation calls. The default expansion mode
remains off; this fix preserves preparation-versus-model-tool routing if an
experimental expansion mode is selected.

The opt-in deferred count is a count of known unstarted discoveries and known
comparisons derived from admitted discoveries. It does not predict comparisons
for skipped discoveries. This differs from the serial loop's count of entries
remaining in its dynamically expanded queue; the two counts are not an estimate
of the same eventual search workload and must not be compared as such. Neither
count invents completed evidence for work that never ran.

## Local evidence and remaining gates

Thirteen new mock checks cover four-lane capacity, dynamic dependencies, reversed
completion, deterministic ordering/IDs, ordinary failure, cancellation/drain,
soft deadlines, immutable request snapshots, two concurrent model-stub reviews,
provider routing, serial compatibility, empty eligible plans, and canonical request equality. They
make no paid model calls or real engine searches. A clean `npm ci --ignore-scripts`
from the committed npm shrinkwrap installed 19 packages (62 MiB). The canonical
`npm run check` then passed the build, all 102 tests, and public TypeScript
consumer checks. Test-source inspection found only mock connectors/providers and
no network or real-engine execution. No package archive was built or overwritten.

The subsequent branch-routing correction passed five additional routing tests
and the complete `npm run check`: build, 107/107 tests, and public type checks.

Before adoption: exact source review, versioned package release checks and reviewed
version publication; app-side provider wiring and container limits; Dev deployment
and application-level evidence/latency qualification. No public package artifact
is built at an existing version. No UI changes are included.
