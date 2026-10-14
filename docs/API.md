# Answer pipeline contracts

Connectors return assistant continuation messages with their proposed tool calls.
Preserve opaque provider continuation metadata in memory. Do not execute proposed
tools in connectors: the pipeline performs validation, dispatch and result append.
Cancellation is checked before invocation, after response and around each tool.
`simpleSystemPolicy` and `simpleToolDescription` expose the existing base policy
builder. Hosts must deliberately supply their chosen policy; this base builder
is not a claim of equivalence to the website's currently selected conversational
policy. Website relay adapters continue injecting the existing server-owned prompt.

Preferred public analyzer lines and conditional segments use `mateInMoves`: signed
mate distance in moves. Explicit `toPositionAnalysis` / `toLegacyPositionAnalysis`
adapters retain legacy provider compatibility and reject contradictory aliases.
Existing versioned trace/evidence outputs keep their historical `matePly` spelling;
this is not a trace-schema migration. See the publication contract documentation.

All observations and diagnostic events may contain user chess data. Hosts choose
storage and retention. Published package files contain no recorded study fixtures,
credentials or private traces. Network and engine work requires an injected port.

Budget behavior is inherited: at most six normal model turns, at most eight
searches per batch, reserved final composition, plus the existing one-slot
recovery rules. There is no new aggregate engine-search quota. Connector output
limits may be requested rather than guaranteed. `usage.outputTokens` retains
legacy budget accounting; check `reportedOutputTokens` and `metering` before
reporting measured usage. Missing usage reserves the call allowance and has an
explicit `outputBudgetReservation`; it is not measured usage or billing.

Requirement KE-AI-PORT-002: `searchesUsed` retains attempted engine dispatch
accounting, including failures. `searchesSucceeded` and `searchesFailed` report
completed search outcomes separately. Preparation retains bounded error message,
code and HTTP status, without stacks or headers. When every completed attempted
search fails, `engineEvidenceStatus` is `unavailable` and the saved answer plainly
discloses that engine analysis could not be completed. A successful later search
clears that all-failed condition. The disclosure precedes final reference validation;
causal claim and sentence-context ranges remain half-open UTF-16 offsets into
the returned final answer. Cancellation remains a failure, and answers
that request no searches are not labelled engine outages. Hosts can mark such
unavailable answers degraded while retaining the pipeline's `diagnostic` status.

Requirement KE-AI-PORT-003: optional observable traces pair input and output/error
phase events for routing performed here, opponent preparation, classification
refresh, observations, evidence construction, and the residual opening wait.
These events use `deterministic`/`local-harness` identity so model-attempt and
billing summaries exclude them. `invocationId` joins each pair; terminal
`durationMs` measures that operation and
`elapsedMs` is relative to pipeline entry. Opening lookup runs concurrently;
its wait duration is only the remaining wait after chess evidence collection.
No event is emitted for an operation that is skipped or routing already supplied
by the host. Existing preparation/result diagnostics remain unchanged. Failed or
cancelled operations emit a terminal timing event and preserve the original error
and cancellation behavior. Phase events never include host error messages,
credentials or chess payloads. Model/tool intervals remain separately measured;
do not sum overlapping source lookup and engine intervals.

Requirement KE-AI-PORT-004: hosts can explicitly set `parallelPreparation: true`
to overlap the two independent ordinary opponent probes and classification refresh
after routing. The probes retain their original evidence order when they finish
out of order. At most three upfront searches can overlap with this opt-in.
The default remains serial, and prepared-board initial searches retain their existing
refresh order. Both ordinary operations complete before observation collection or
model invocation. On failure the sibling is cancelled and drained before the
original failure is propagated; explicit cancellation prevents model dispatch.
Hosts must provide analyzers that safely support the overlap. `preparationAnalyzer`
can select a separate provider for ordinary opponent probes only; evidence tools
and prepared-board initial searches still use `analyzer`. Classification remains
owned by the history bridge. No search, freshness, score or classification semantics
are relaxed, and engine outages continue to use the inherited degraded-answer path.
Overlapping phase durations must not be summed as sequential wall time.

Connector capability metadata declares `toolRequests`, `toolFreeComposition`,
`opaqueContinuation` booleans; `outputTokenLimit` is `enforced`, `requested` or
`unavailable`; `usageReporting` is `reported`, `optional` or `unavailable`.
The interface rejects an entire proposed batch before dispatch if a call ID is
empty or repeated, a tool is unknown, arguments are not objects, or the batch
exceeds 32 calls. This is an interface admission ceiling, separate from the
inherited eight-search batch limit. Detailed chess schema and legality checks
remain in the canonical tool wrappers and host.


See the [pipeline source](../src/chess-reasoning/answer-pipeline.ts) and [connector contract](../src/chess-reasoning/answer-model-connector.ts).


### Completed MultiPV results

Fresh engine presentation witnesses interpret `multiPv` as the requested maximum.
An unrestricted completed search can return one through that many valid lines;
the original requested count remains in the witness even when fewer lines arrive.
Explicit `rootMoves` searches must still cover their entire requested root set.
Depth, score, provenance, distinct-root and legal-PV checks remain unchanged.

## Host-owned engine clients

`createEngineAnalysisProvider(client)` is exported from the package root and the
small `@knights-eye-chess/ai-analysis/engine` entry point. The latter imports no
model SDK or engine implementation. AI Analysis declares its own structural
`AnalysisEngineClient` contract; the host wires a compatible implementation.

The adapter translates a depth request to `limit: { depth }` and maps completed
engine candidates to AI lines without changing scores, mate units, achieved depth,
PV length or provenance. A valid result can contain fewer lines than requested.
Engine/weights identity remains attributed; different engines are not blended.
This is not evidence admission or a calibration of another engine's scores for
the Knight's Eye classifier. Nodes/time-limited human-likelihood evidence needs
its own consumer contract rather than masquerading as depth-search evidence.

The host owns lifecycle and closes the client. `minimumPvPlies` does not make this
adapter perform extra searches or pad PVs. Existing downstream admission and
continuation handling remain responsible for evidence use.
Scored results require an explicit completed `bestmove` matching the first scored
root. An explicit `noMove: true` result with empty candidates, `bestmove: null`,
and top-level `engineBuild` maps to no scored lines and a null best move. This is
only a UCI no-move report: the host checks legal moves at the FEN before claiming
checkmate, stalemate, or another chess terminal condition.
