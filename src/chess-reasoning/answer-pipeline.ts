import { classificationTargetAtSelection } from './classification-question-target';
import { DEFAULT_BRANCH_EXPANSION_MODE, BRANCH_EXPANSION_OPTIONS, withBranchPreparation, selectBranchHost } from './branch-expansion-policy';
import { planInitialSearches } from './initial-search-plan';
import { withRecordedPositionTools, memoizeToolResults } from './recorded-position-tools';
import type { AnswerRoutingPreparation, AnswerSelection, AnswerHistoryPort, AnswerOpeningSession } from './answer-host-contracts';
import { prepareOpponentThreats } from "./opponent-threat-preparation";
import { simpleBoardAnalysis } from "./simple-board-analysis";
import { createContextEvidence, REASONING_POC_VERSION, reasoningContextHash, createQueryContract, DEFAULT_REASONING_RUN_CONTROLS } from "./poc-contracts";
import type { PriorConversationMessage } from "./conversation-context";
import type { SimpleAgentConfig } from "./simple-agent-config";
import { captureAblationOriginalEvidenceBundle } from "./ablation-evidence-capture";
import { toLegacyPositionAnalysisProvider, type CompatiblePositionAnalysisProvider } from "./position-analysis-contracts";
import type { ObservationProvider } from "./poc-contracts";
import type { AnswerModelConnector } from "./answer-model-connector";
import type { WikibooksIndex } from "./wikibooks-index";
import { emitObservableTrace, type ObservableLlmTraceSink } from "./ai-sdk-runtime-support";
import { createDefaultSaliencePolicy } from "./poc-observations";
import { createPocToolHost } from "./poc-tools";
import { runPreparedAnswer, SIMPLE_MODELS, SIMPLE_BUDGETS, SIMPLE_EXPANDED_BUDGETS, SIMPLE_RECOVERY_BUDGETS } from "./portable-answer-runtime";
import type { PlayerPerspective } from "../player-perspective";

export type AnswerPipelineResult = Awaited<ReturnType<typeof runPreparedAnswer>> & { arm: "Simple"; bundleHash: string };

export async function runAnswerPipeline(input: {
  connector: AnswerModelConnector;
  policy?: Parameters<typeof runPreparedAnswer>[0]["policy"];
  modelName?: string;
  providerRoute?: string;
  analyzer?: CompatiblePositionAnalysisProvider;
  /** Optional analyzer for ordinary opponent preparation; later model tools still use analyzer. */
  preparationAnalyzer?: CompatiblePositionAnalysisProvider;
  /** Opt in only when the host can safely serve overlapping preparation and classification searches. */
  parallelPreparation?: boolean;
  /** Server full-game opt-in; four chains use stable chain/child IDs instead of serial IDs. */
  initialSearchConcurrency?: 1 | 4;
  /** Required for the opt-in: answer-isolated independent one-thread provider; no normal-provider fallback. */
  initialPreparationAnalyzer?: CompatiblePositionAnalysisProvider;
  observationProvider: ObservationProvider;
  prepareRouting: () => Promise<AnswerRoutingPreparation>;
  openingSession?: AnswerOpeningSession;
  openingIndex?: () => Promise<WikibooksIndex>;
  routingPreparation?: AnswerRoutingPreparation;
  conversationHistory?: readonly PriorConversationMessage[];
  simpleConfig?: SimpleAgentConfig;
  simpleAllowance?: "default" | "expanded" | "glm-recovery";
  requestId: string;
  question: string;
  playerPerspective?: PlayerPerspective | null;
  selected: AnswerSelection;
  bridge?: AnswerHistoryPort;
  signal?: AbortSignal;
  observableTraceSink?: ObservableLlmTraceSink;
  onProgress?: (message: string) => void;
}): Promise<AnswerPipelineResult> {
  if (input.initialSearchConcurrency !== undefined && ![1, 4].includes(input.initialSearchConcurrency)) throw Error("Unsupported initial-search concurrency");
  const parentSignal = input.signal;
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener("abort", abort, { once: true });
  // Only explicit cancellation aborts; the native loop owns soft completion.
  input = { ...input, signal: controller.signal };
  let sourceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preparationStarted = performance.now();
    let phaseSequence = 0;
    // Paired phase events measure work before the model loop. They do not carry
    // chess payloads or errors that might contain host transport credentials.
    const timed = async <T>(stage: string, operation: () => T | Promise<T>, details: Record<string, unknown> = {}, phaseSignal = input.signal): Promise<T> => {
      const started = performance.now();
      const invocationId = `${input.requestId}:pipeline-phase:${++phaseSequence}`;
      const trace = (direction: "input" | "output" | "error", payload: Record<string, unknown>) => emitObservableTrace(input.observableTraceSink, {
        stage, direction, model: "deterministic", providerRoute: "local-harness", reasoningEffort: "none",
        payload: { invocationId, ...details, ...payload, elapsedMs: performance.now() - preparationStarted },
      });
      trace("input", {});
      try {
        const result = await operation();
        trace("output", { status: "completed", durationMs: performance.now() - started });
        return result;
      } catch (error) {
        trace("error", { status: phaseSignal?.aborted ? "cancelled" : "failed", durationMs: performance.now() - started });
        throw error;
      }
    };
    const routing = input.routingPreparation ?? await timed("answer-pipeline-routing", input.prepareRouting);
    if(routing.question!==input.question||routing.selectionKey!==input.selected.selectionKey||routing.deliveryId!==input.selected.deliveryId)throw Error('stale-question-routing');
    const omitSelectedContext=routing.omitSelectedContext;
    if(input.signal?.aborted)throw input.signal.reason??Error('cancelled');
    // Public MediaWiki traffic must never pass through the credentialed model relay.
    const openingSession = input.openingSession;
    const allowance = input.simpleAllowance === 'glm-recovery' ? SIMPLE_RECOVERY_BUDGETS
      : input.simpleAllowance === 'expanded' ? SIMPLE_EXPANDED_BUDGETS : SIMPLE_BUDGETS;
    const sourceDeadlineMs = Math.max(0, allowance.maxWallTimeMs - 60000);
    let sourceTimedOut = false;
    const sourceController = new AbortController();
    const sourceSignal = AbortSignal.any([controller.signal, sourceController.signal]);
    const prepareGameOpening = routing.decision.reviewGame && routing.mainLine;
    const openingLookup = (prepareGameOpening || !omitSelectedContext) && openingSession ? (() => {
      sourceTimer = setTimeout(() => { sourceTimedOut = true; sourceController.abort(); },
        Math.max(0, sourceDeadlineMs - (input.routingPreparation?.elapsedMs ?? 0) - (performance.now() - preparationStarted)));
      return (async () => {
        const results = await Promise.all([
          ...(prepareGameOpening ? [openingSession.gameReview(prepareGameOpening, sourceSignal)] : []),
          ...(!omitSelectedContext ? [openingSession.initial(sourceSignal)] : []),
        ]);
        const pages = [...new Map(results.flatMap(result => result.pages).map(page => [`${page.title}@${page.revisionId}`, page])).values()];
        return {...results[0], status:pages.length ? 'available' as const : results[0].status, pages,
          requestCount:results.reduce((count, result) => count + result.requestCount, 0),
          localIndexCandidateCount:results.reduce((count, result) => count + result.localIndexCandidateCount, 0),
          localIndexPositionCheckCount:results.reduce((count, result) => count + result.localIndexPositionCheckCount, 0),
          localIndexSelectedTitleCount:results.reduce((count, result) => count + result.localIndexSelectedTitleCount, 0),
          cacheHitTitleCount:results.reduce((count, result) => count + result.cacheHitTitleCount, 0),
          networkRequestCount:results.reduce((count, result) => count + result.networkRequestCount, 0),
          networkRequestedTitles:results.flatMap(result => result.networkRequestedTitles),
          timingMs:Math.max(...results.map(result => result.timingMs)),
          limitations:[...new Set(results.flatMap(result => result.limitations))]};
      })().finally(() => clearTimeout(sourceTimer));
    })() : undefined;
    const analyzer = input.analyzer ? toLegacyPositionAnalysisProvider(input.analyzer) : undefined;
    const preparationAnalyzer = input.preparationAnalyzer ? toLegacyPositionAnalysisProvider(input.preparationAnalyzer) : analyzer;
    const baseSearchPlan = planInitialSearches({question:input.question,context:input.selected.context,mainLine:routing.mainLine,reviewGame:routing.decision.reviewGame,reviewSubject:routing.decision.reviewSubject,answerScope:routing.decision.answers?.answer_scope?.choice,classificationQuestion:classificationTargetAtSelection(routing.decision,input.question,input.selected.context).applies,omitSelectedContext,playerPerspective:input.playerPerspective});
    // Capture the selected chess context before refresh can replace host analysis.
    // Classification refresh changes existingAnalysis, not the selected position.
    const selectedContext = input.selected.context;
    const prepare = preparationAnalyzer && !omitSelectedContext && !baseSearchPlan.requests.length
      ? () => timed("answer-pipeline-preparation", () => prepareOpponentThreats(selectedContext, preparationAnalyzer, input.signal, input.onProgress, { parallel: input.parallelPreparation })) : undefined;
    const refresh = () => timed("answer-pipeline-classification-refresh", () => input.bridge!.refreshContext!(input.selected, input.signal), { origin: "opponent-threat-preparation" });
    let preparation: Awaited<ReturnType<typeof prepareOpponentThreats>>;
    let refreshed: Awaited<ReturnType<NonNullable<AnswerHistoryPort["refreshContext"]>>> | undefined;
    if (input.parallelPreparation && prepare && selectedContext.kind !== "position" && input.bridge?.refreshContext) {
      input.onProgress?.("Refreshing move classification and candidate moves");
      const preparationWork = prepare();
      const classificationWork = refresh();
      try {
        [preparation, refreshed] = await Promise.all([preparationWork, classificationWork]);
        input.signal?.throwIfAborted();
      } catch (error) {
        // Abort and drain the sibling before the host tears down answer resources.
        // Promise.all observes both rejections; preserve the first operation's error.
        controller.abort(error);
        await Promise.allSettled([preparationWork, classificationWork]);
        throw error;
      }
    } else {
      preparation = prepare ? await prepare() : undefined;
      input.onProgress?.("Refreshing move classification and candidate moves");
      refreshed = preparation && input.bridge?.refreshContext ? await refresh() : undefined;
    }
    const initialSearchPlan=withBranchPreparation(baseSearchPlan,input.selected.context,omitSelectedContext,DEFAULT_BRANCH_EXPANSION_MODE);
    // Never reuse a pre-search snapshot when no refresh capability is available.
    const existingAnalysis = refreshed?.existingAnalysis ?? (preparation ? null : input.selected.existingAnalysis);
    input.onProgress?.("Collecting compact chess evidence");
    // Include attributed current board context; never include future recorded play.
    const { boardAnalysis, observations } = await timed("answer-pipeline-observations", async () => {
      const boardAnalysis = simpleBoardAnalysis(input.selected.context, existingAnalysis, input.selected.edgeId);
      const provider = input.observationProvider;
      const observations = input.selected.context.kind === "position" ? { schemaVersion: REASONING_POC_VERSION, contextHash: reasoningContextHash(input.selected.context), observations: [], evidence: [createContextEvidence(input.selected.context)], providers: [{ provider: "validated-starting-position", version: "1" }], limitations: [] } : await provider.observe(input.selected.context, DEFAULT_REASONING_RUN_CONTROLS, input.signal);
      return { boardAnalysis, observations };
    });
    const { bundle, hostOptions, expandedOptions, host, initialPreparationHost, getMainLine } = await timed("answer-pipeline-evidence-collection", () => {
      const contract = createQueryContract({ requestId: input.requestId, question: input.question, context: input.selected.context });
      const rankedObservations = createDefaultSaliencePolicy(DEFAULT_REASONING_RUN_CONTROLS.maxObservationsPresented).rank(observations, contract);
      const bundle = captureAblationOriginalEvidenceBundle({ context: input.selected.context, question: input.question,
        observations, rankedObservations, retainAllExactFacts: true });
      const hostOptions = { ...(analyzer ? { analyzer } : {}), defaultDepth:18, minimumDepth:18, maxDepth:18, maxRootMoves:6, leadingAlternative:boardAnalysis?.leadingAlternative };
      const baseHost = createPocToolHost(input.selected.context, hostOptions);
      const expandedOptions={...hostOptions,branchExpansion:BRANCH_EXPANSION_OPTIONS};
      const expandedHost=createPocToolHost(input.selected.context,expandedOptions);
      // Freeze one validated record per answer; later navigation cannot replace it.
      let mainLine = routing.mainLine;
      const getMainLine = async (signal?:AbortSignal) => mainLine ?? (mainLine = await input.bridge!.getMainLine!(input.selected,signal));
      const ordinaryHost = (initialSearchPlan && (mainLine || input.bridge?.getMainLine)
        ? withRecordedPositionTools(input.selected.context,baseHost,hostOptions,getMainLine) : baseHost);
      const expandedRecordedHost=initialSearchPlan && (mainLine || input.bridge?.getMainLine)
        ? withRecordedPositionTools(input.selected.context,expandedHost,expandedOptions,getMainLine) : expandedHost;
      const host=selectBranchHost(memoizeToolResults(ordinaryHost),memoizeToolResults(expandedRecordedHost),DEFAULT_BRANCH_EXPANSION_MODE);
      let initialPreparationHost: typeof host | undefined;
      if (input.initialSearchConcurrency === 4 && initialSearchPlan.reviewScope && initialSearchPlan.requests.length > 0 &&
        initialSearchPlan.requests.every(request => request.tool === 'analyze_game_position')) {
        if (!input.initialPreparationAnalyzer) throw Error('Four-lane preparation requires an independent provider');
        const options = {...hostOptions, analyzer: toLegacyPositionAnalysisProvider(input.initialPreparationAnalyzer)};
        const expanded = {...options, branchExpansion: BRANCH_EXPANSION_OPTIONS};
        initialPreparationHost = selectBranchHost(
          memoizeToolResults(withRecordedPositionTools(input.selected.context, createPocToolHost(input.selected.context, options), options, getMainLine)),
          memoizeToolResults(withRecordedPositionTools(input.selected.context, createPocToolHost(input.selected.context, expanded), expanded, getMainLine)), DEFAULT_BRANCH_EXPANSION_MODE);
      }
      return { bundle, hostOptions, expandedOptions, host, initialPreparationHost, getMainLine };
    });
    const openingSourceContext = openingLookup ? await timed("answer-pipeline-opening-wait", () => openingLookup) : undefined;
    const preModelElapsedMs = Math.max(sourceTimedOut ? sourceDeadlineMs : 0, performance.now() - preparationStarted + (input.routingPreparation?.elapsedMs??0));
    const result = await runPreparedAnswer({ ...input, bundle, host, boardAnalysis, preparation, openingSourceContext, initialSearchPlan,
      initialPreparationHost, initialSearchConcurrency: initialPreparationHost ? 4 : 1,
      refreshPreparedBoardAnalysis: async signal => {
        hostOptions.leadingAlternative=undefined;
        expandedOptions.leadingAlternative=undefined;
        const fresh=input.bridge?.refreshContext
          ? await timed("answer-pipeline-classification-refresh", () => input.bridge!.refreshContext!(input.selected,signal), { origin: "initial-search-preparation" }, signal) : undefined;
        const analysis=simpleBoardAnalysis(input.selected.context,fresh?.existingAnalysis??null,input.selected.edgeId);
        hostOptions.leadingAlternative=analysis?.leadingAlternative;
        expandedOptions.leadingAlternative=analysis?.leadingAlternative;
        return analysis;
      },
      omitSelectedContext, initialMainLine:routing.mainLine, routingDecision:routing.decision, openingSourceLookup: openingSession ? (targets, signal, root) => openingSession.lookup(targets, signal, root) : undefined, preModelElapsedMs, analysisDepth: 18,
      getMainLine: input.bridge?.getMainLine ? signal => getMainLine(signal) : undefined,
      modelName: input.modelName ?? input.simpleConfig?.modelId ?? SIMPLE_MODELS["Simple-Sol"], effort: input.simpleConfig?.effort ?? "medium" });
    return { ...result, arm: "Simple", bundleHash: bundle.bundleHash };
  } finally {
    clearTimeout(sourceTimer);
    parentSignal?.removeEventListener("abort", abort);
  }
}
