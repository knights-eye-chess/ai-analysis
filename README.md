# Knight's Eye AI Analysis

Build a chess question-and-answer feature around a model, legal chess tools and
engine evidence. AI Analysis prepares an exact game or position context, lets the
model request bounded investigations, and checks references in the final answer.

Use it in a study assistant, game-review app or your own chess tooling. Your host
supplies the model connector, routing and observation provider, plus optional
engine analysis, opening lookup and history access.

For a ready-to-run terminal host, see [CLI Tools](https://github.com/knights-eye-chess/cli-tools).

## How it works

1. Your app selects a position or move with its exact starting FEN and history.
2. The pipeline collects observations and prepares available evidence.
3. The model proposes chess tool calls; the pipeline validates and executes them.
4. The pipeline reserves a final composition turn and validates answer references.

The package provides the loop. Your app owns UI, credentials, model transport,
engine hosting, persistence and privacy settings for chess data and traces.

## Get started

Use Node 24 or newer. Install the published prerelease with the chess library
imported by the example below:

```sh
npm install @knights-eye-chess/ai-analysis@next chess.js@1.4.0
```

The first reviewed registry candidate is `0.1.0-dev.14`; pin the exact version
for a reproducible install. Source developers can use `npm ci` and
`npm run pack:checked` in this checkout.
[SOURCE-ORIGIN.json](SOURCE-ORIGIN.json) records historical archive provenance.

This runnable example uses a local connector with a fixed answer. It needs no
provider credentials or engine, and demonstrates host wiring rather than model
or chess quality:

```js
import { Chess } from 'chess.js';
import { runAnswerPipeline, createProductionObservationProvider,
  QUESTION_ROUTING_VERSION, simpleSystemPolicy,
  simpleToolDescription } from '@knights-eye-chess/ai-analysis';

const fen = new Chess().fen();
const question = 'Assess the starting position';
const context = {
  kind: 'position', nodeId: 'root', historyStartFen: fen, historyUci: [],
  moveUci: '', moveSan: '', fenBefore: fen, fenAfter: fen
};
const result = await runAnswerPipeline({
  requestId: 'example', question,
  selected: { deliveryId: 'example', selectionKey: 'root', edgeId: 'root',
    context, existingAnalysis: null },
  connector: {
    kind: 'model-turn',
    async invoke() {
      const text = 'No engine evaluation was supplied.';
      return { text, toolCalls: [], finishReason: 'stop', usage: {},
        response: { messages: [{ role: 'assistant', content: text }] } };
    }
  },
  policy: { system: simpleSystemPolicy, description: simpleToolDescription },
  observationProvider: createProductionObservationProvider({ context, question }),
  prepareRouting: async () => ({
    question, selectionKey: 'root', deliveryId: 'example', elapsedMs: 0,
    omitSelectedContext: false,
    decision: {
      version: QUESTION_ROUTING_VERSION, status: 'fallback',
      omitSelectedContext: false, includeGameRecord: false, reviewGame: false,
      reason: 'explicit-host-position',
      answers: { answer_scope: { choice: 'position_analysis', confidence: 1 } }
    }
  })
});
console.log(result.answer);
```

For a live model, `createNativeAnswerConnector(model)` adapts an AI SDK
LanguageModel, or implement `AnswerModelConnector` for your own transport.
A connector returns proposed tool calls and ordered continuation messages;
**the pipeline executes the tools**. Preserve opaque provider continuation
metadata in memory so later turns can resume correctly.

## Integrate with your app

`runAnswerPipeline` performs preparation and investigation. `runPreparedAnswer`
accepts an already captured evidence bundle. Both expose cancellation, progress
and optional trace hooks. Inject your chosen system policy deliberately; the
exported simple policy does not promise the website's current conversational behavior.

Engine analysis is optional. When completed attempted searches all fail, the
result reports unavailable engine evidence and the answer includes that disclosure.
Attempted, successful and failed search counts are separate. Missing usage is
reported as unknown with a conservative budget reservation; it is not measured
billing or zero token use.

The loop allows up to six normal model turns and eight searches per batch,
with reserved composition and recovery rules. `parallelPreparation: true` can
overlap ordinary preparation only when your analyzer safely supports concurrent
searches. The default is serial.

## Documentation and APIs

The supported host API is the root entry point, `@knights-eye-chess/ai-analysis`, with runtime
exports and TypeScript declarations. The separate [research entry](docs/RESEARCH-API.md)
serves existing experimental evidence/replay tooling. Pure host protocol and
presentation helpers use `@knights-eye-chess/ai-analysis/shared`; its runtime
imports only chess.js and excludes model SDKs and the answer loop. Execution
hosts use the root API.
See the [ownership adoption record](docs/OWNERSHIP-ADOPTION.md) for preserved behavior. Start with:

- [Pipeline inputs](src/chess-reasoning/answer-pipeline.ts): selection, routing, analysis and host ports.
- [Connector contract](src/chess-reasoning/answer-model-connector.ts): turns, tool calls and capabilities.
- [Evidence, budgets and tracing](docs/API.md): authority, failure behavior and diagnostics.
- [Integration examples](test/answer-pipeline.test.mjs): host setup and deterministic connector scenarios.

Public analyzer lines use `mateInMoves`, a signed distance in moves. Explicit
adapters support legacy provider forms; existing versioned traces keep their
historical `matePly` spelling. Reference validation checks supported references;
it does not certify every claim in generated prose or qualify model answer quality.

## Development and license

```sh
npm ci
npm run check
npm run pack:checked
```

Edit source here. [SOURCE-ORIGIN.json](SOURCE-ORIGIN.json) records the historical
extraction; no old application checkout is needed. Tests exercise real legality
and evidence tools with deterministic model/analyzer doubles. They do not qualify
live provider transport or engine strength. See [npm publishing](NPM-PUBLISHING.md)
for release preparation.

First-party code is **[AGPL-3.0-or-later](LICENSE)**. See [licensing details](LICENSING.md)
and [third-party notices](THIRD_PARTY_NOTICES.md).
