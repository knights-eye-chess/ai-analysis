# Answer pipeline (private Phase 6 preview)

Requirement KE-AI-PORT-001: preserve the existing preparation, evidence nomination,
search batch limits, six model turn budget, reserved composition, exact occurrence
history, reference validation and cancellation in one reusable loop. Model
connectors propose tools across resumable turns; the pipeline alone executes them.
The website uses the same source. Host applications own routing, engine analysis,
opening lookup, accounts, transport, persistence and credentials.

`runAnswerPipeline` performs the existing preparation and investigation/composition;
`runPreparedAnswer` accepts already captured evidence. `createNativeAnswerConnector`
adapts an AI SDK LanguageModel; a custom `AnswerModelConnector` invokes any model
turn interface, including a local mock. Delegated agent execution is a different
product contract, not a interchangeable connector. No provider comparison or paid
answer-quality equivalence is claimed.

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

Build independently with `npm install` and `npm run build` in the unpacked
package. `src` is generated from canonical repository modules for packaging,
never a second editable implementation. `npm test` runs the deterministic
connector conformance checks against genuine chess legality/evidence tools.
The deterministic analyzer is a test double and does not qualify engine strength,
provider transport, live answer quality or correctness of generated prose.

Connector capability metadata declares `toolRequests`, `toolFreeComposition`,
`opaqueContinuation` booleans; `outputTokenLimit` is `enforced`, `requested` or
`unavailable`; `usageReporting` is `reported`, `optional` or `unavailable`.
The interface rejects an entire proposed batch before dispatch if a call ID is
empty or repeated, a tool is unknown, arguments are not objects, or the batch
exceeds 32 calls. This is an interface admission ceiling, separate from the
inherited eight-search batch limit. Detailed chess schema and legality checks
remain in the canonical tool wrappers and host.

## Standalone repository build

Use Node 24 or newer. From a clean checkout:

```sh
npm ci
npm run check
npm run pack:checked
```

The source snapshot is recorded in `SOURCE-ORIGIN.json`. This private preview
uses version `0.1.0-dev.8`; earlier `0.1.0-dev.1`, `0.1.0-dev.2`,
`0.1.0-dev.3`, `0.1.0-dev.4`, `0.1.0-dev.5` and `0.1.0-dev.6` artifacts remain immutable.
Internal dependencies are pinned archives in `vendor/npm`. Update an existing
dependency with `node scripts/update-dependency.mjs @knights-eye-chess/name
/absolute/path/package.tgz`, then run `npm ci` and `npm run check`. Review the
manifest, lockfile, archive hash and tests together before committing.
No registry, automatic CI or website deployment is required for these commands.

`pack:artifact` packs a temporary copy and records exact package versions for
sibling dependencies. Use it instead of bare `npm pack`; repository-local file
pins belong to the source build and are not published as consumer dependencies.
