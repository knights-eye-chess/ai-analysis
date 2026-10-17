import { scheduleInitialSearches } from './initial-search-scheduler';
import { classificationReassessment } from './classification-reassessment';
import { CHESS_REFERENCE_DICTIONARY } from './chess-reference-dictionary';
import type { RecordedSelectedClassification } from './recorded-selected-classification';
import { createToolInputLoopGuard } from './tool-input-loop-guard';
import { visibleSupportLines } from './visible-support-lines';
import { compactMechanism } from './mechanism-presentation';
import { projectEnginePresentation } from './simple-engine-presentation';
import { consolidatePreparedSearches, type PreparedPresentation } from './preparation-consolidation';
import type { WikibooksIndex } from './wikibooks-index';
import { compactPreparedSearchResult } from './compact-search-preparation';
import { validateAnswerReferences } from './answer-reference-validation';
import { scoreComparisonNotices } from './score-comparison-notices';
import { completionPacket, evidenceFallback } from "./simple-completion";
import { AI_MODEL_CONTEXT_MAX_BYTES } from "../ai-request-limits";
import { readAiRoutingDiagnostics } from '../ai-routing-diagnostics';
import { recordedEvidenceContext } from './recorded-reference-context';
import {openingSourcesInMessages,openingSourceKey,type OpeningSourceCredit} from './opening-source-credits';
import type { MaterialFormat } from './material-format';
import { shareEvidenceMessages, hasSharedEvidence } from "./lossless-evidence-sharing";
import { isRecordedPositionTool } from './recorded-position-tools';
import { preparedMoveComparison, type InitialSearchPlan } from './initial-search-plan';
import { wikibooksTargetsForToolIndexed } from "./wikibooks-tool-context";
import type { WikibooksContextResult, WikibooksTarget } from "./opening-source-contracts";
import {EXPLANATION_REVIEW_SCHEMA,legalInvestigationRoots,validateExplanationReview,explanationCoverage,explanationSummary,planningEvidence,type ExplanationReview} from './simple-explanation-coverage';
import { failureFromError, type AiFailureDetails } from "../ai-request-failure";
import type { SimpleBoardAnalysis } from "./simple-board-analysis";
import { priorConversationMessages, type PriorConversationMessage } from "./conversation-context";
import { recordedMainLineResult } from "./recorded-main-line";
import { moveSectionScope } from './question-routing';
import type { RecordedMainLine } from "./answer-host-contracts";
import type { SimpleEffort } from "./simple-agent-config";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { invokeAnswerTurn, type AnswerModelConnector } from "./answer-model-connector";
import { simpleInitialEvidenceView, compactSimpleEngineResult } from "./simple-evidence-view";
import { SimpleFactDelivery } from "./simple-fact-delivery";
import { projectLeanDirectEvidence } from "./ablation-lean-direct-runtime";
import { validateAblationEvidenceClosureBundle, type AblationEvidenceClosureBundle } from "./ablation-evidence-bundle";
import { emitObservableTrace, observableTraceMessages, type ObservableLlmTraceSink } from "./ai-sdk-runtime-support";
import { effectiveLicensesForRecord } from "./evidence-licenses";
import { createContextEvidence, reasoningContextHash, type ReasoningEvidenceRecord, type ReasoningToolSet, type ReasoningToolName } from "./poc-contracts";
import type { PlayerPerspective } from "../player-perspective";

export { SIMPLE_TOOL_AGENT_VERSION } from "./simple-runtime-version";
export const SIMPLE_MODELS = { "Simple-Sol": "openai/gpt-5.6-sol", "Simple-Opus": "anthropic/claude-opus-5" } as const;
export type SimpleModelOption = keyof typeof SIMPLE_MODELS;
export const SIMPLE_BUDGETS = Object.freeze({ maxModelCalls: 6, maxOutputTokensPerCall: 6000,
  maxSearchesPerBatch: 8, maxOutputTokens: 18000, maxWallTimeMs: 180000, maxRequestBytes: AI_MODEL_CONTEXT_MAX_BYTES, maxDepth: 14, maxRootMoves: 6 });
export const SIMPLE_EXPANDED_BUDGETS = Object.freeze({ ...SIMPLE_BUDGETS,
  maxOutputTokensPerCall: 12000, maxOutputTokens: 36000, maxWallTimeMs: 300000 });
export const SIMPLE_RECOVERY_BUDGETS = Object.freeze({ ...SIMPLE_BUDGETS,
  maxOutputTokensPerCall: 24000, maxOutputTokens: 72000, maxWallTimeMs: 600000 });
export const SIMPLE_DISCLOSURE = "Experimental answer. Tool inputs, legality, evidence scope and interactive references are checked at completion and reported in referenceValidation; prose correctness and claim entailment are not validated. Unresolved references remain plain text.";

/** Keep only billing and bounded routing metadata; provider reasoning stays private in continuation memory. */
export function simpleUsageForTrace(usage: unknown, metadata: unknown, headers?: Record<string, string>) {
  const cost = (metadata as {openrouter?:{usage?:{cost?:unknown}}}|undefined)?.openrouter?.usage?.cost;
  const serviceRouting = readAiRoutingDiagnostics(headers);
  return {usage, ...(serviceRouting ? {serviceRouting} : {}), ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? {providerMetadata:{openrouter:{usage:{cost}}}} : {})};
}

// Only the finite scalar/array argument vocabulary of the existing six chess
// tools. The tool host remains responsible for exact legality and phase replay.
function inputError(code: string, field: string, expected: string, details?: string, choices?: unknown[]) {
  return Object.assign(new Error(`${field}: ${expected}${details ? `; ${details}` : ""}`), {code, field, expected, ...(details?{details}:{}), ...(choices?{choices:choices.slice(0,32)}:{})});
}
function toolError(error: unknown) {
  const e = error as {message?:unknown;code?:unknown;field?:unknown;expected?:unknown;details?:unknown;choices?:unknown};
  const bounded = (value: unknown, n=300) => typeof value === 'string' ? value.slice(0,n) : undefined;
  const message=bounded(e?.message) || 'tool-failed';
  return {error:message,code:bounded(e?.code,80) || message,
    ...(bounded(e?.field,100)?{field:bounded(e.field,100)}:{}),
    ...(bounded(e?.expected)?{expected:bounded(e.expected)}:{}),
    ...(bounded(e?.details)?{details:bounded(e.details)}:{}),
    ...(Array.isArray(e?.choices)?{choices:e.choices.slice(0,32).filter((choice):choice is string=>typeof choice==='string').map(choice=>choice.slice(0,100))}:{})};
}
export function validateSimpleToolInput(name: string, input: Record<string, unknown>, schema: Record<string, unknown>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError('invalid-tool-input','input','object');
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const unknown=Object.keys(input).find(key=>!Object.hasOwn(properties,key));
  if (unknown) throw inputError('unknown-tool-field',unknown,'known schema field',undefined,Object.keys(properties));
  const missing=((schema.required || []) as string[]).find(key=>input[key]===undefined);
  if (missing) throw inputError('missing-tool-field',missing,'required field',undefined,Object.keys(properties));
  for (const [key, value] of Object.entries(input)) {
    // Retired metadata is discarded; never require a paid repair for it.
    if (name === "explanation_review" && key === "shortLineReasons") continue;
    const rule = properties[key];
    if (rule.enum && !(rule.enum as unknown[]).includes(value)) throw inputError('invalid-tool-enum',key,'one of the listed values',undefined,rule.enum as unknown[]);
    if (rule.type === "boolean" && typeof value !== "boolean") throw inputError('invalid-tool-boolean',key,'boolean');
    if (rule.type === "integer" && (!Number.isInteger(value) || (rule.minimum!==undefined && Number(value)<Number(rule.minimum)) || (rule.maximum!==undefined && Number(value)>Number(rule.maximum)))) throw inputError('invalid-tool-integer',key,`integer${rule.minimum!==undefined?` >= ${rule.minimum}`:''}${rule.maximum!==undefined?` <= ${rule.maximum}`:''}`);
    if (rule.type === 'string' && (typeof value !== 'string' || (rule.minLength!==undefined && value.length<Number(rule.minLength)) || (rule.maxLength!==undefined && value.length>Number(rule.maxLength)) || (rule.pattern!==undefined && !new RegExp(String(rule.pattern)).test(value)))) throw inputError('invalid-tool-string',key,`string${rule.maxLength!==undefined?` of at most ${rule.maxLength} characters`:''}${rule.pattern!==undefined?` matching ${rule.pattern}`:''}`);
    if (rule.type === "array") {
      if (!Array.isArray(value) || value.length < Number(rule.minItems || 0) || (rule.maxItems!==undefined && value.length > Number(rule.maxItems))) throw inputError('invalid-tool-array',key,`array of ${rule.minItems??0}..${rule.maxItems??'unbounded'} items`);
      if (name === "search_batch" && key === "requests") {
        continue;
      }
      const itemRule=rule.items as Record<string,unknown> | undefined;
      value.forEach((item,index)=>{
        const field=`${key}[${index}]`;
        if (itemRule?.enum && !(itemRule.enum as unknown[]).includes(item)) throw inputError('invalid-tool-enum',field,'one of the listed values',undefined,itemRule.enum as unknown[]);
        if (itemRule?.type === "integer" && (!Number.isInteger(item) || (itemRule.minimum!==undefined && Number(item)<Number(itemRule.minimum)) || (itemRule.maximum!==undefined && Number(item)>Number(itemRule.maximum)))) throw inputError('invalid-tool-integer',field,`integer${itemRule.minimum!==undefined?` >= ${itemRule.minimum}`:''}${itemRule.maximum!==undefined?` <= ${itemRule.maximum}`:''}`);
        if (itemRule?.type === "string") {
          const maximum=Number(itemRule.maxLength??300);
          if(typeof item!=="string" || item.length>maximum || (itemRule.minLength!==undefined && item.length<Number(itemRule.minLength)) || (itemRule.pattern!==undefined && !new RegExp(String(itemRule.pattern)).test(item))) throw inputError('invalid-tool-string',field,`string of at most ${maximum} characters${itemRule.pattern?` matching ${itemRule.pattern}`:''}`);
        }
      });
      if ((key === "squares" || key === "inspectSquares") && value.some(item => !/^[a-h][1-8]$/.test(item))) throw inputError('invalid-square',key,'chess squares a1 through h8');
      if ((key === "movesUci" || key === "rootMoves" || key === "compareFinalMovesUci") && value.some(item => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(item))) throw inputError('invalid-uci',key,'UCI coordinate moves such as e2e4 or a7a8q');
      if ((name === "compare_moves" || name === "enumerate_defenses") && value.length > SIMPLE_BUDGETS.maxRootMoves) throw inputError('root-budget',key,`at most ${SIMPLE_BUDGETS.maxRootMoves} root moves`);
    }
  }
}

export type SimpleAgentDiagnostic = { stage: string; inputTokens: number; outputTokens: number; latencyMs: number; finishReason: string };
export async function runPreparedAnswer(input: {
  policy?: { system: (flags: {encoded:boolean;reusedFacts:boolean;sharedEvidence?:boolean;final:boolean;purposeGuidance?:boolean;searchBreadthGuidance?:boolean;boardAnalysisGuidance?:boolean;explanationCoverage?:boolean;answerComposition?:'move-explanation'|'none'}) => string; description: (name:string) => string };  connector: AnswerModelConnector; openingIndex?: () => Promise<WikibooksIndex>; modelName: string; requestId: string;
  /** Offline evaluation only; callers supply a condition-specific bundle without withheld evidence. */
  evaluation?: { fixedEvidence: true; requiredEvidenceIds: string[] };
  /** Node evaluation only: provider metering is unavailable; no browser caller sets this. */
  evaluationTransport?: { kind: "subagent-files" | "openrouter-direct"; wallTimeMs: number };
  /** Baseline switch for controlled serializer evaluation only. */
  evidenceCompaction?: "baseline" | "lossless";
  /** Node comparison override; browser uses the qualified default. */
  materialFormat?: MaterialFormat;
  question?: string;
  /** Diagnostic ablation only; live Simple enables bounded explanation review. */
  explanationCoverage?: boolean;
  boardAnalysis?: SimpleBoardAnalysis;
  recordedSelectedClassification?: RecordedSelectedClassification;
  /** Research ablation; normal evidence always includes the standard reference. */
  squareReference?: boolean;
  openingSourceContext?: WikibooksContextResult;
  openingSourceLookup?: (targets: WikibooksTarget[], signal: AbortSignal, root?: import("./poc-contracts").ReasoningPositionContext) => Promise<WikibooksContextResult>;
  /** Total overlapping browser preparation time, including optional source wait. */
  preModelElapsedMs?: number;
  playerPerspective?: PlayerPerspective | null;
  conversationHistory?: readonly PriorConversationMessage[];
  getMainLine?: (signal: AbortSignal) => Promise<RecordedMainLine>;
  initialMainLine?: RecordedMainLine;
  initialSearchPlan?: InitialSearchPlan;
  /** Explicit server full-game prototype. Serial IDs and behavior remain the default. */
  initialSearchConcurrency?: 1 | 4;
  /** A dedicated host backed by at most four independent one-thread searches per answer. */
  initialPreparationHost?: ReasoningToolSet;
  refreshPreparedBoardAnalysis?: (signal:AbortSignal)=>Promise<SimpleBoardAnalysis | undefined>;
  omitSelectedContext?: boolean;
  routingDecision?: import('./question-routing').QuestionRoutingDecision;
  effort?: SimpleEffort;
  providerRoute?: string;
  /** Explicit browser analysis policy; frozen diagnostic defaults remain unchanged. */
  analysisDepth?: 18;
  preparation?: import("./simple-evidence-preparation").SimpleEvidencePreparation;
  purposeGuidance?: boolean;
  searchBreadthGuidance?: boolean;
  boardAnalysisGuidance?: boolean;
  simpleAllowance?: "default" | "expanded" | "glm-recovery";
  bundle: Readonly<AblationEvidenceClosureBundle>; host: ReasoningToolSet; signal?: AbortSignal;
  observableTraceSink?: ObservableLlmTraceSink; onProgress?: (message: string) => void }) {
  validateAblationEvidenceClosureBundle(input.bundle);
  if (input.simpleAllowance && !["default", "expanded", "glm-recovery"].includes(input.simpleAllowance)) throw new Error("invalid-simple-allowance");
  if (input.simpleAllowance === "glm-recovery" && input.modelName !== "z-ai/glm-5.3") throw new Error("recovery-allowance-model");
  const allowance = input.simpleAllowance === "glm-recovery" ? SIMPLE_RECOVERY_BUDGETS
    : input.simpleAllowance === "expanded" ? SIMPLE_EXPANDED_BUDGETS : SIMPLE_BUDGETS;
  const budgets = { ...allowance, maxWallTimeMs: Number(allowance.maxWallTimeMs), maxOutputTokens: Number(allowance.maxOutputTokens), ...(input.analysisDepth ? { defaultDepth: input.analysisDepth, minimumDepth: input.analysisDepth, maxDepth: input.analysisDepth } : {}) };
  if (input.evaluationTransport && !["subagent-files", "openrouter-direct"].includes(input.evaluationTransport.kind)) throw Error("invalid-evaluation-transport");
  const subagentEvaluation = input.evaluationTransport?.kind === "subagent-files" ? input.evaluationTransport : undefined;
  if (input.evaluationTransport?.kind === "openrouter-direct") {
    const wall = input.evaluationTransport.wallTimeMs;
    if (input.providerRoute !== "openrouter-direct" || !Number.isInteger(wall) || wall < 1000 || wall > 1800000) throw Error("invalid-openrouter-evaluation");
    budgets.maxWallTimeMs = wall;
  }
  if (subagentEvaluation) {
    if (subagentEvaluation.kind !== "subagent-files" || input.providerRoute !== "codex-subagent-file"
      || !Number.isInteger(subagentEvaluation.wallTimeMs) || subagentEvaluation.wallTimeMs < 1000
      || subagentEvaluation.wallTimeMs > 1800000) throw Error("invalid-subagent-evaluation");
    budgets.maxWallTimeMs = subagentEvaluation.wallTimeMs;
    // Reserve each entire response allowance when actual usage is unavailable.
    // This is a safety counter, not a token measurement.
    budgets.maxOutputTokens = budgets.maxModelCalls * budgets.maxOutputTokensPerCall;
  }
  const contextHash = reasoningContextHash(input.bundle.context);
  const delivery = new SimpleFactDelivery(contextHash);
  if (input.evaluation && (input.evaluation.fixedEvidence !== true || !Array.isArray(input.evaluation.requiredEvidenceIds)
    || input.evaluation.requiredEvidenceIds.some(id => typeof id !== "string" || !id.trim()))) throw Error("invalid-fixed-evidence-evaluation");
  const fixedEvidence = input.evaluation?.fixedEvidence === true;
  const initialGameRecord=input.initialMainLine?recordedMainLineResult(input.initialMainLine,input.bundle.context):undefined;
  const omitSelectedContext=input.omitSelectedContext===true;
  const answerComposition=input.routingDecision ? moveSectionScope(input.routingDecision) : 'none';
  if(omitSelectedContext&&(!initialGameRecord||input.initialMainLine!.truncated||fixedEvidence))throw Error('context-omission-requires-complete-game-record');
  let selectedContextAvailable=!omitSelectedContext;
  const coverageEnabled = !omitSelectedContext && !fixedEvidence && input.explanationCoverage !== false && input.bundle.context.kind !== 'position';
  let review:ExplanationReview|null=null, reviewCount=0;
  const stopRepairs=0, qualificationRequested=false;
  const requiredEvidenceIds = [...new Set([...(input.preparation?.result?.evidence.map(e => e.id) ?? []),
    ...(input.evaluation?.requiredEvidenceIds ?? [])])];
  const initial = projectLeanDirectEvidence(input.bundle, requiredEvidenceIds).bundle;
  if (fixedEvidence && requiredEvidenceIds.some(id => !initial.evidence.some(record => record.id === id))) throw Error("fixed-evidence-projection-omitted-required-record");
  const visibleIds = new Set(omitSelectedContext?[]:initial.evidence.map(e => e.id));
  const known = new Map(input.bundle.evidence.map(e => [e.id, e]));
  // Lean observation selection can omit the context record. Deliver the selected
  // transition independently, retaining its exact record for normal retrieval.
  const selectedContextRecord = input.bundle.context.kind === 'position' ? undefined : createContextEvidence(input.bundle.context,contextHash);
  if (selectedContextRecord) {
    known.set(selectedContextRecord.id,selectedContextRecord);
    if (!omitSelectedContext) visibleIds.add(selectedContextRecord.id);
  }
  const selectedMechanism = selectedContextRecord?.data.selectedMoveMechanism;
  const selectedMechanismView = selectedContextRecord && selectedMechanism && typeof selectedMechanism === 'object' && !Array.isArray(selectedMechanism)
    ? {evidenceId:selectedContextRecord.id,fenBefore:input.bundle.context.fenBefore,
      fenAfter:input.bundle.context.fenAfter,moveUci:input.bundle.context.moveUci,
      mechanism:compactMechanism(selectedMechanism,
        (selectedMechanism.controlDelta as Array<{square:string}>).map(delta=>delta.square))} : undefined;
  if (input.boardAnalysis) {
    if (input.boardAnalysis.record.contextHash !== contextHash) throw Error("stale-board-analysis");
    known.set(input.boardAnalysis.record.id, input.boardAnalysis.record);
    if(!omitSelectedContext)visibleIds.add(input.boardAnalysis.record.id);
  }
  const previousClassificationAnalysis = input.initialSearchPlan?.classificationReassessment && !omitSelectedContext ? structuredClone(input.boardAnalysis) : undefined;
  const visibleRecords=()=>[...known.values()].filter(e=>visibleIds.has(e.id));
  let lastRecurringSummary="";
  const recurringForTurn=()=>{const summary=explanationSummary(input.bundle.context,visibleRecords());const encoded=JSON.stringify(summary);if(encoded===lastRecurringSummary)return {unchanged:true,scope:"Reuse the identical recurring summary already delivered in this current native loop."};lastRecurringSummary=encoded;return summary;};
  const started = performance.now(), controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
  const preparationMs = input.preModelElapsedMs ?? input.preparation?.elapsedMs ?? 0;
  if (!Number.isFinite(preparationMs) || preparationMs < 0 || (input.preparation && (!Number.isFinite(input.preparation.elapsedMs) || input.preparation.elapsedMs < 0 || preparationMs < input.preparation.elapsedMs || ![0, 1, 2, 3].includes(input.preparation.searchCount)))) throw Error("invalid-evidence-preparation");
  const timeToFinish = () => performance.now() - started + preparationMs >= Math.max(0, budgets.maxWallTimeMs - 60000);
  const diagnostics: SimpleAgentDiagnostic[] = [];
  let unmeteredCalls=0, reportedOutputTokens=0, outputBudgetReservation=0, unmeteredInputCalls=0, reportedInputTokens=0;
  const toolRuns: Record<string, unknown>[] = [];
  const acquiredMainLines: Array<ReturnType<typeof recordedMainLineResult>["recordedMainLine"]> = initialGameRecord?[initialGameRecord.recordedMainLine]:[];
  const actionable = new Set(['insufficient_credits','invalid_key','rate_limited','model_unavailable','free_unavailable','free_funds_exhausted','ai_request_active','ai_hourly_limit','ai_admission_busy','sign_in_required','forbidden','connection_changed','cancelled']);
  let failureDetails: AiFailureDetails | undefined;
  let completionReason: string | null = null;
  let toolCount = 0, searchCount = input.preparation?.searchCount ?? 0, outputTokens = 0, answer = "", failure: string | null = null, contractFailure = false;
  // Legacy preparation remains accepted; known retained records establish only
  // their own completed outcomes, never an assumed success for missing records.
  let searchesSucceeded = input.preparation?.searchesSucceeded ?? (input.preparation?.result ? 1 : input.preparation?.rawRecords?.length ?? 0);
  let searchesFailed = input.preparation?.searchesFailed ?? (input.preparation?.failure ? input.preparation.searchCount : 0);
  // Count engine dispatches for diagnostics; cancellation/time, not a count quota, gates them.
  const execution = { reserveAdditionalSearch: () => {
    controller.signal.throwIfAborted();
    searchCount++;
    return true;
  }, reserveSearch: () => {
    controller.signal.throwIfAborted();
    searchCount++;
    return true;
  }, recordSearchOutcome: (outcome: 'succeeded' | 'failed') => {
    if (outcome === 'succeeded') searchesSucceeded++; else searchesFailed++;
  } };
  const trace = (stage: string, direction: "input" | "output" | "error", payload: Record<string, unknown>) => emitObservableTrace(input.observableTraceSink,
    { stage, direction, model: input.modelName, providerRoute: input.providerRoute ?? "model-turn", reasoningEffort: input.effort ?? "medium", payload });
  if (input.preparation) trace("simple-preparation", "output", { ...input.preparation });
  const source = input.openingSourceContext;
  const openingSourceContext = (!omitSelectedContext || source?.scope === 'game-review') && source?.status === "available" && source.contextHash === contextHash && source.pages.length
    ? { authority: "untrusted-opening-commentary", contextHash, pages: source.pages, limitations: source.limitations }
    : undefined;
  if (source) trace("simple-opening-source", "output", { ...source, injected: Boolean(openingSourceContext) });
  const withOpeningSource = (chessResult: unknown, openingSourceContext: unknown) => openingSourceContext ? { chessResult, openingSourceContext } : chessResult;
  const deliveredSources = new Set(openingSourceContext?.pages.map(page => `${page.title}@${page.revisionId}`) ?? []);
  const knownOpeningPages=new Map((openingSourceContext?.pages??[]).map(page=>[openingSourceKey(page),page]));
  const openingSources=new Map<string,OpeningSourceCredit>();
  const theoryForTool = async (name: string, args: Record<string, unknown>, result: import("./poc-contracts").ReasoningToolResult) => {
    if (!input.openingSourceLookup || controller.signal.aborted) return undefined;
    const sourceStarted = performance.now();
    try {
      if (!input.openingIndex) return undefined;
      const catalog = await input.openingIndex();
      if (controller.signal.aborted) return undefined;
      const candidates = wikibooksTargetsForToolIndexed(input.bundle.context, name, args, result, catalog);
      if (!candidates.candidateCount) return undefined;
      const targets = candidates.targets;
      const root = isRecordedPositionTool(name) ? recordedEvidenceContext(input.bundle.context, result.data.recordedPosition) : input.bundle.context;
      const source: WikibooksContextResult = targets.length ? await input.openingSourceLookup(targets, controller.signal, root) : {
        status:'unavailable',contextHash:reasoningContextHash(root),pages:[],requestCount:0,networkRequestCount:0,
        networkRequestedTitles:[],localIndexCandidateCount:0,localIndexPositionCheckCount:0,
        localIndexSelectedTitleCount:0,cacheHitTitleCount:0,timingMs:0,
        limitations:[`No indexed usable prose at candidate positions or their two actual-path ancestors; no titles built and no MediaWiki request. Catalog: ${catalog.at}.`],
      };
      const diagnosedSource = {...source,timingMs:Math.round(performance.now()-sourceStarted),localIndexPositionCheckCount:(source.localIndexPositionCheckCount ?? 0)+candidates.positionChecks};
      if (controller.signal.aborted) return undefined;
      if (source.contextHash !== reasoningContextHash(root)) throw Error("stale-opening-source");
      const pages: WikibooksContextResult["pages"] = [], alreadyPresented: Array<Pick<WikibooksContextResult["pages"][number], "title" | "revisionId" | "positionFen" | "relation" | "matchedTargets" | "requestedTitle" | "ancestorPlies" | "transposition">> = [];
      if (source.status === "available") for (const page of source.pages) {
        const key = `${page.title}@${page.revisionId}`;
        if (deliveredSources.has(key)) alreadyPresented.push({title:page.title,revisionId:page.revisionId,positionFen:page.positionFen,relation:page.relation,...(page.matchedTargets ? {matchedTargets:page.matchedTargets,requestedTitle:page.requestedTitle,ancestorPlies:page.ancestorPlies,transposition:page.transposition} : {})});
        else { pages.push(page); deliveredSources.add(key); knownOpeningPages.set(key,page); }
      }
      const packet = { ...diagnosedSource, authority: "untrusted-opening-commentary", pages, alreadyPresented };
      trace("simple-opening-source", "output", { tool: name, callId: result.callId, lookupMode: 'local-fen-index-then-network', candidatePositionCount:candidates.candidateCount, selectedTitleCount:targets.length, selectedTitleSample:targets.slice(0,3).map(t=>t.title.slice(0,180)), selectedTitleSampleTruncated:targets.length>3||targets.some(t=>t.title.length>180), ...packet, injected: pages.length > 0, reused: alreadyPresented.length });
      return packet;
    } catch (error) {
      trace("simple-opening-source", "error", { tool: name, callId: result.callId, status: controller.signal.aborted ? "aborted" : "unavailable", error: error instanceof Error ? error.message : "source-unavailable" });
      return undefined;
    }
  };
  const toolInputGuard=createToolInputLoopGuard();
  const initialSearches: Array<Record<string,unknown>> = [];
  const initialSearchPresentations: PreparedPresentation[] = [];
  const preparationDependencies=new Map<InitialSearchPlan["requests"][number],string>();
  const initialPreparedEvidenceIds:string[]=[];
  let deferredPreparationRequests=0;
  if (!fixedEvidence && input.initialSearchPlan) {
    const parallel = input.initialSearchConcurrency === 4 && input.initialSearchPlan.requests.length > 0;
    if (input.initialSearchConcurrency !== undefined && ![1, 4].includes(input.initialSearchConcurrency)) throw Error('Unsupported initial-search concurrency');
    if (parallel && (!input.initialPreparationHost || !input.initialSearchPlan.reviewScope ||
      input.initialSearchPlan.requests.some(request => request.tool !== 'analyze_game_position'))) throw Error('Parallel preparation requires a dedicated full-game host');
    const preparationHost = parallel ? input.initialPreparationHost! : input.host;
    const descriptors=new Map(preparationHost.descriptors().map(d=>[d.name,d]));
    const prepared = parallel ? await scheduleInitialSearches({
      requests: input.initialSearchPlan.requests, signal: controller.signal, shouldDefer: timeToFinish,
      execute: async (request, callId) => {
        const descriptor = descriptors.get(request.tool); if (!descriptor) throw Error('tool-unavailable');
        validateSimpleToolInput(request.tool, request.input, descriptor.inputSchema);
        input.onProgress?.('Preparing relevant engine comparisons');
        const result = await preparationHost.execute(request.tool, {...request.input,callId,contextHash}, controller.signal, execution);
        controller.signal.throwIfAborted();
        if (result.contextHash !== contextHash || result.callId !== callId || result.tool !== request.tool) throw Error('cross-context-tool-result');
        for (const evidence of result.evidence) {
          if (evidence.contextHash !== contextHash || !evidence.id) throw Error('cross-context-evidence');
          effectiveLicensesForRecord(evidence);
        }
        return result;
      }, comparison: (request, result) => preparedMoveComparison(request, result.evidence),
    }).catch(error => { input.signal?.removeEventListener('abort', abort); throw error; }) : undefined;
    deferredPreparationRequests = prepared?.deferred ?? 0;
    const preparationQueue=prepared ? prepared.items.map(item => item.request) : [...input.initialSearchPlan.requests];
    for(const [index,request] of preparationQueue.entries()) {
      const acquired = prepared?.items[index];
      const callId=acquired?.callId ?? `initial-search-${index+1}`, start=performance.now();
      if (acquired?.discoveryCallId) preparationDependencies.set(request, acquired.discoveryCallId);
      const run:Record<string,unknown>={origin:'automatic-preparation',callId,...request};
      let preparedModelResult: unknown;
      let preparedRecords: ReasoningEvidenceRecord[]=[],preparedLimitations:string[]=[];
      const playedMove = request.playedMove ?? (Number.isInteger(request.input.ply) ? input.initialMainLine?.moves[Number(request.input.ply)]?.uci : request.input.phase === 'before' && input.bundle.context.kind !== 'position' ? input.bundle.context.moveUci : undefined);
      try {
        controller.signal.throwIfAborted();
        if(!prepared && timeToFinish()) {deferredPreparationRequests=preparationQueue.length-index;break;}
        const descriptor=descriptors.get(request.tool);if(!descriptor)throw Error('tool-unavailable');
        if(omitSelectedContext&&!isRecordedPositionTool(request.tool))throw Error('selected-context-not-loaded');
        validateSimpleToolInput(request.tool,request.input,descriptor.inputSchema);
        if (!prepared) input.onProgress?.('Preparing relevant engine comparisons');
        if (acquired && 'error' in acquired.outcome) throw acquired.outcome.error;
        const result=acquired && 'value' in acquired.outcome ? acquired.outcome.value : await preparationHost.execute(request.tool,{...request.input,callId,contextHash},controller.signal,execution);
        controller.signal.throwIfAborted();
        if(result.contextHash!==contextHash||result.callId!==callId||result.tool!==request.tool)throw Error('cross-context-tool-result');
        for(const e of result.evidence){if(e.contextHash!==contextHash||!e.id)throw Error('cross-context-evidence');effectiveLicensesForRecord(e);const old=known.get(e.id);if(old&&JSON.stringify(old)!==JSON.stringify(e))throw Error('evidence-identity-conflict');}
        for(const e of result.evidence){known.set(e.id,e);visibleIds.add(e.id);initialPreparedEvidenceIds.push(e.id);}
        if(!prepared && request.playedMove && request.tool==='analyze_game_position') {
          const comparison=preparedMoveComparison(request, result.evidence);
          if(comparison){preparationDependencies.set(comparison,callId);preparationQueue.splice(index+1,0,comparison);}
        }
        const openingSource = await theoryForTool(request.tool, request.input, result);
        controller.signal.throwIfAborted();
        preparedRecords=result.evidence;preparedLimitations=result.limitations;
        preparedModelResult = withOpeningSource(compactPreparedSearchResult(result, playedMove, input.materialFormat), openingSource);
        Object.assign(run,{status:'completed',result:withOpeningSource(compactSimpleEngineResult({contextHash,evidence:result.evidence,limitations:result.limitations},input.materialFormat), openingSource)});
      } catch(error) { if(controller.signal.aborted){input.signal?.removeEventListener('abort',abort);throw error;}Object.assign(run,{status:'failed',...toolError(error)}); }
      run.elapsedMs=(acquired?.elapsedMs ?? 0)+performance.now()-start;initialSearches.push(run);
      initialSearchPresentations.push({callId,modelRun:preparedModelResult === undefined ? {...run} : {...run,result:preparedModelResult},records:preparedRecords,limitations:preparedLimitations,playedMove,discoveryCallId:preparationDependencies.get(request)});
      trace('simple-initial-search','output',run);
    }
  }
  const consolidatedPreparation=consolidatePreparedSearches(initialSearchPresentations);
  if(input.initialSearchPlan)trace('simple-preparation-consolidation','output',consolidatedPreparation.diagnostics);
  if(initialSearches.some(r=>!isRecordedPositionTool(String(r.tool))) && !omitSelectedContext) {
    // Fresh root searches can change canonical classifications. Never send a stale
    // pre-search snapshot alongside newer engine evidence.
    if(input.boardAnalysis)visibleIds.delete(input.boardAnalysis.record.id);
    input.boardAnalysis=undefined;
    try { input.boardAnalysis=await input.refreshPreparedBoardAnalysis?.(controller.signal); }
    catch(error) { if(controller.signal.aborted){input.signal?.removeEventListener('abort',abort);throw error;}trace('simple-initial-search','error',{stage:'refresh-board-analysis',...toolError(error)}); }
    if(input.boardAnalysis){if(input.boardAnalysis.record.contextHash!==contextHash){input.signal?.removeEventListener('abort',abort);throw Error('stale-board-analysis');}known.set(input.boardAnalysis.record.id,input.boardAnalysis.record);visibleIds.add(input.boardAnalysis.record.id);}
  }
  // The historical label has independent provenance; never substitute it for a
  // freshly refreshed canonical badge or expose it for an omitted selection.
  const classificationReview = input.initialSearchPlan?.classificationReassessment && !omitSelectedContext
    ? {...classificationReassessment(previousClassificationAnalysis, input.boardAnalysis), searchStatus: initialSearches[0]?.status ?? 'not-run'} : undefined;
  if(classificationReview?.labelChanged && previousClassificationAnalysis) visibleIds.add(previousClassificationAnalysis.record.id);
  const recordedClassification=!input.boardAnalysis?.snapshot?.classification ? input.recordedSelectedClassification : undefined;
  if(recordedClassification?.record.contextHash && recordedClassification.record.contextHash!==contextHash)throw Error('stale-recorded-selected-classification');
  if(recordedClassification && !omitSelectedContext) {
    known.set(recordedClassification.record.id,recordedClassification.record);visibleIds.add(recordedClassification.record.id);
  }
  const playerPerspective = input.playerPerspective;
  const planningInitial = coverageEnabled ? {...initial, evidence:planningEvidence({contextHash,evidence:[...initial.evidence],limitations:[]}).evidence} : initial;
  const selectedEvidence = () => ({...simpleInitialEvidenceView(planningInitial,input.bundle,budgets,Boolean(input.boardAnalysis),input.materialFormat),
    ...(selectedMechanismView?{selectedMoveMechanism:selectedMechanismView}:{}),
    ...(input.boardAnalysis?{boardAnalysis:input.boardAnalysis.snapshot}:{}),
    ...(classificationReview?{classificationReassessment:classificationReview}:{}),
    ...(recordedClassification?{recordedSelectedClassification:recordedClassification.snapshot}:{}),
    ...(coverageEnabled?{legalInvestigationRoots:legalInvestigationRoots(input.bundle.context)}:{}),
    ...(input.preparation?.investigationLeads?{investigationLeads:input.preparation.investigationLeads}:{}),
    ...(openingSourceContext?{openingSourceContext}:{}),
    ...(input.preparation?{preparation:{searchesUsed:input.preparation.searchCount,searchesSucceeded,searchesFailed,limitation:'Prepared continuations are bounded evidence, not a purpose inference.'}}:{})});
  let gameView:Record<string,unknown>|undefined;
  if(initialGameRecord){
    const record=Object.fromEntries(Object.entries(initialGameRecord.recordedMainLine).filter(([key])=>!["selectedIndex","selectedAtStart","selectedOnMainLine"].includes(key)));
    gameView={recordedMainLine:omitSelectedContext?record:initialGameRecord.recordedMainLine,
      ...('recordedAnalysis' in initialGameRecord?{recordedAnalysis:initialGameRecord.recordedAnalysis}:{}),
      complete:!input.initialMainLine!.truncated,limitations:omitSelectedContext?["PGN is reconstructed from recorded moves; use recordedMainLine.outcome for the source-reported result and verified ending. Other original headers and clocks are not included.","Recorded primary-line play, not proof of best play or intent. This is not an arbitrary branch continuation."]:initialGameRecord.limitations};
    if(!omitSelectedContext)for(const e of initialGameRecord.evidence){known.set(e.id,e);visibleIds.add(e.id);}
  }
  const standardReference=input.squareReference===false?undefined:CHESS_REFERENCE_DICTIONARY;
  const currentQuestion={...(standardReference?{standardReference}:{}),scoreComparisonNotices:scoreComparisonNotices(visibleRecords()),scope:'CURRENT_QUESTION',...(playerPerspective?{playerPerspective}:{}),
    ...(omitSelectedContext?{question:input.question??input.bundle.question,selectionContext:'omitted',budgets,
      contextAvailability:'The selected move/position was not supplied. The complete recorded primary game is supplied independently of the board selection. Use get_selected_context before any selection-relative chess tool; do not guess a root or treat a historical move as the current selection.'}:selectedEvidence()),
    ...(gameView?{gameRecord:gameView}:{}),
    ...(openingSourceContext?{openingSourceContext}:{}),
    ...(input.initialSearchPlan?{initialSearchPreparation:{...input.initialSearchPlan,results:consolidatedPreparation.results,searchesUsed:searchCount,deferredRequests:deferredPreparationRequests,completion:deferredPreparationRequests?'partial: soft deadline reached; final answer must disclose unfinished preparation':'finished; inspect individual failures',scope:'Optional bounded leads, not exhaustive review or proof of prose. Reuse supplied results; request dependent follow-ups only as useful.'}}:{}),
    ...(input.routingDecision?{evidenceRouting:{version:input.routingDecision.version,selectedContext:omitSelectedContext?'omitted':'included',gameRecord:gameView?(input.initialMainLine!.truncated?'partial':'complete'):'not-initially-supplied',answerComposition}}:{evidenceRouting:{answerComposition}})};
  const messages:ModelMessage[]=[...priorConversationMessages(input.conversationHistory),{role:'user',content:JSON.stringify(currentQuestion)}];
  if(input.routingDecision)trace('question-evidence-plan','output',{version:input.routingDecision.version,status:input.routingDecision.status,appliedOmission:omitSelectedContext,gameRecordComplete:gameView?.complete??false,gameRecordTrigger:input.routingDecision.gameRecordTrigger,answerScope:input.routingDecision.answers?.answer_scope,answerComposition,reason:input.routingDecision.reason});

  trace("simple-evidence", "output", { context: input.bundle.context, initialEvidence: omitSelectedContext?[]:initial.evidence, retainedEvidence: [...known.values()] });
  const descriptors = input.host.descriptors().filter(d => (d.category === "fact" || d.category === "probe") && !(input.bundle.context.kind === "position" && ["analyze_move", "enumerate_defenses"].includes(d.name)));
  const searchDescriptors = descriptors.filter(d => d.category === "probe");
  const searchDescriptorByName = new Map(searchDescriptors.map(d => [d.name, d]));
  const batchSearchSchema: Record<string, unknown> = { type: "object", additionalProperties: false, required: ["requests"], properties: {
    requests: { type: "array", minItems: 1, maxItems: budgets.maxSearchesPerBatch, items: { type: "object", additionalProperties: false,
      required: ["tool", "input"], properties: {
        queryId: { type: "string", description: "Optional correlation ID. Invalid, missing, and repeated values are assigned a unique query ID with an explicit mapping." },
        tool: { type: "string", enum: searchDescriptors.map(d => d.name) },
        input: { type: "object" },
      } },
    },
  } };
  const retrievalSchema: Record<string, unknown> = { type: "object", additionalProperties: false, required: ["evidenceIds"], properties: {
    evidenceIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", maxLength: 300 } } } };
  const definitions = [...(omitSelectedContext?[{name:"get_selected_context",description:input.policy?.description("get_selected_context"),inputSchema:{type:"object",additionalProperties:false,properties:{}}}]:[]),...(coverageEnabled ? [{name:'explanation_review',description:input.policy?.description('explanation_review'),inputSchema:EXPLANATION_REVIEW_SCHEMA}] : []), ...(input.getMainLine && (!input.initialMainLine || input.initialMainLine.truncated) ? [{ name: "get_main_line", description: input.policy?.description("get_main_line"), inputSchema: { type: "object", additionalProperties: false, properties: {} } }] : []), ...descriptors.map(d=>({...d,description:input.policy?.description(d.name),inputSchema:["compare_moves","enumerate_defenses"].includes(d.name)?{...d.inputSchema,properties:{...(d.inputSchema.properties as Record<string,unknown>),[d.name==="compare_moves"?"movesUci":"rootMoves"]:{...((d.inputSchema.properties as Record<string,Record<string,unknown>>)[d.name==="compare_moves"?"movesUci":"rootMoves"]),maxItems:budgets.maxRootMoves}}}:d.inputSchema})),
    ...(searchDescriptors.length ? [{ name: "search_batch", description: input.policy?.description("search_batch"), inputSchema: batchSearchSchema }] : []),
    { name: "retrieve_evidence", description: input.policy?.description("retrieve_evidence"), inputSchema: retrievalSchema }];
  const tools = Object.fromEntries(definitions.map(d => [d.name, tool({ description: d.description,
    inputSchema: jsonSchema<Record<string, unknown>>(d.inputSchema), execute: async (args, options) => {
      if (controller.signal.aborted) throw new Error("cancelled");
      if (timeToFinish()) return {error:"investigation-closed",evidence:[],limitation:"Time to summarize acquired evidence. This request was not executed."};
      if(d.name==='explanation_review')reviewCount++;else toolCount += 1;
      const run: Record<string, unknown> = { tool: d.name, input: args, callId: options.toolCallId, status: "started" };
      toolRuns.push(run); trace("simple-tool", "input", run);
      const start = performance.now();
      let admittingEvidence = false;
      try {
        toolInputGuard.validate(d.name,args,()=>validateSimpleToolInput(d.name, args, d.inputSchema));
        if(d.name==='get_selected_context') {
          selectedContextAvailable=true;
          if(selectedContextRecord)visibleIds.add(selectedContextRecord.id);
          for(const e of initial.evidence)visibleIds.add(e.id);
          if(input.boardAnalysis)visibleIds.add(input.boardAnalysis.record.id);
          if(recordedClassification){known.set(recordedClassification.record.id,recordedClassification.record);visibleIds.add(recordedClassification.record.id);}
          const result={selectionContext:'included',...selectedEvidence()};
          Object.assign(run,{status:'completed',result,elapsedMs:performance.now()-start});trace('simple-tool','output',run);return result;
        }
        if(!selectedContextAvailable && !['get_main_line','search_batch','retrieve_evidence'].includes(d.name) && !isRecordedPositionTool(d.name))
          throw inputError('selected-context-not-loaded','context','Call get_selected_context before selection-relative chess tools. Historical game positions are not automatically the selected root.');
        if(d.name==='explanation_review') {
          review=validateExplanationReview(args,input.bundle.context,known);
          const newlyPresented=review.evidenceIds.filter(id=>!visibleIds.has(id)).map(id=>known.get(id)!);
          for(const e of newlyPresented)visibleIds.add(e.id);
          const result={supportingEvidence:planningEvidence({contextHash,evidence:newlyPresented,limitations:[]}),coverage:explanationCoverage(input.bundle.context,visibleRecords(),review),recurring:recurringForTurn()};
          Object.assign(run,{status:'completed',result,elapsedMs:performance.now()-start});trace('simple-tool','output',run);return result;
        }
        if (d.name === "search_batch") {
          const requests = args.requests as Array<{ queryId?: unknown; tool?: unknown; input?: unknown }>;
          const queryIds = new Set<string>();
          const reservedIds=new Set(requests.map(r=>r && typeof r==='object' && typeof r.queryId==='string' && /^[A-Za-z0-9_-]{1,48}$/.test(r.queryId)?r.queryId:null).filter((id):id is string=>Boolean(id)));
          const queryIdRepairs: Array<{index:number;requestedQueryId:unknown;queryId:string;reason:string}>=[];
          input.onProgress?.(`Checking ${requests.length} chess searches`);
          const searches: Record<string, unknown>[] = [];
          // The browser host owns one Stockfish worker. Keep engine execution
          // ordered while eliminating extra model round trips around known probes.
          for (const [index, request] of requests.entries()) {
            const suppliedId=request && typeof request==='object' ? request.queryId : undefined;
            const validId=typeof suppliedId==='string' && /^[A-Za-z0-9_-]{1,48}$/.test(suppliedId);
            let queryId=validId && !queryIds.has(suppliedId) ? suppliedId : `batch_${index+1}`;
            if(!validId || queryIds.has(suppliedId as string)){
              while(reservedIds.has(queryId) || queryIds.has(queryId))queryId=`${queryId}_`;
              queryIdRepairs.push({index,requestedQueryId:suppliedId??null,queryId,reason:validId?'duplicate':'missing-or-invalid'});
            }
            queryIds.add(queryId);
            const toolName = request && typeof request==='object' ? request.tool as ReasoningToolName : undefined;
            const callId = `${options.toolCallId}/${queryId}`;
            const searchStart = performance.now();
            let validatingHostResult = false;
            try {
              if(!request || typeof request!=='object' || Array.isArray(request))throw inputError('invalid-batch-search',`requests[${index}]`,'object with tool and input');
              const unknown=Object.keys(request).find(key=>!["queryId","tool","input"].includes(key));
              if(unknown)throw inputError('unknown-batch-search-field',`requests[${index}].${unknown}`,'queryId, tool or input');
              if(typeof toolName!=='string'||!searchDescriptorByName.has(toolName))throw inputError('invalid-batch-search-tool',`requests[${index}].tool`,'available search tool',undefined,[...searchDescriptorByName.keys()]);
              if(!request.input || typeof request.input!=='object' || Array.isArray(request.input))throw inputError('invalid-batch-search-input',`requests[${index}].input`,'object matching selected tool schema');
              toolInputGuard.validate(toolName,request.input as Record<string,unknown>,()=>validateSimpleToolInput(toolName,request.input as Record<string,unknown>,searchDescriptorByName.get(toolName)!.inputSchema));
              if(!selectedContextAvailable && !isRecordedPositionTool(toolName))throw inputError('selected-context-not-loaded','context','Call get_selected_context before selection-relative tools.');
              if(timeToFinish()) throw Error("investigation-closed: summarize acquired evidence");
              if(input.host.reservesSearchAtDispatch!==true && !(['test_line','test_game_line'].includes(toolName) && (request.input as {analyzeFinal?:unknown}).analyzeFinal!==true))execution.reserveSearch();
              const result = await input.host.execute(toolName, { ...(request.input as Record<string, unknown>), callId, contextHash }, controller.signal, execution);
              validatingHostResult = true;
              if (result.contextHash !== contextHash || result.callId !== callId || result.tool !== toolName) throw new Error("cross-context-tool-result");
              if (controller.signal.aborted) throw new Error("cancelled");
              for (const e of result.evidence) {
                if (e.contextHash !== contextHash || !e.id) throw new Error("cross-context-evidence");
                effectiveLicensesForRecord(e);
                const old = known.get(e.id);
                if (old && JSON.stringify(old) !== JSON.stringify(e)) throw new Error("evidence-identity-conflict");
              }
              for (const e of result.evidence) { known.set(e.id, e); visibleIds.add(e.id); }
              const openingSourceContext = await theoryForTool(toolName, request.input as Record<string, unknown>, result);
              if (controller.signal.aborted) throw new Error("cancelled");
              const compact = { contextHash, evidence: result.evidence, limitations: result.limitations, scoreComparisonNotices:scoreComparisonNotices(visibleRecords()).filter(n=>n.observations.some(o=>result.evidence.some(e=>e.id===o.evidenceId))) };
              const full = compactSimpleEngineResult(coverageEnabled ? planningEvidence(compact) : compact,input.materialFormat);
              const reused = coverageEnabled ? full : compactSimpleEngineResult(delivery.project(callId, projectEnginePresentation(compact) as typeof compact),input.materialFormat);
              searches.push({ queryId, tool: toolName, input: request.input, callId, status: "completed",
                result: withOpeningSource(JSON.stringify(reused).length < JSON.stringify(full).length ? reused : full, openingSourceContext), elapsedMs: performance.now() - searchStart });
            } catch (error) {
              if (validatingHostResult && !controller.signal.aborted) contractFailure = true;
              const detail=toolError(error);
              searches.push({ queryId, tool: toolName, input: request && typeof request==='object' ? request.input : undefined, callId, status: "failed", ...detail,
                result: { ...detail, evidence: [], limitation: "No evidence acquired by this failed search." }, elapsedMs: performance.now() - searchStart });
            }
          }
          const batched = { contextHash, searches, ...(queryIdRepairs.length?{queryIdRepairs}:{}), ...(coverageEnabled?{investigation:explanationCoverage(input.bundle.context,visibleRecords(),review),recurring:recurringForTurn()}:{}) };
          Object.assign(run, { status: "completed", result: batched, elapsedMs: performance.now() - start });
          trace("simple-tool", "output", run);
          return batched;
        }
        input.onProgress?.(d.name === "retrieve_evidence" ? "Retrieving chess evidence" : `Checking ${d.name.replaceAll("_", " ")}`);
        let result;
        if (d.name === "get_main_line") {
          result = recordedMainLineResult(await input.getMainLine!(controller.signal), input.bundle.context);
          acquiredMainLines.push(result.recordedMainLine);
        } else if (d.name === "retrieve_evidence") {
          const ids = args.evidenceIds as string[];
          if(!selectedContextAvailable&&ids.some(id=>!visibleIds.has(id)))throw inputError('selected-context-not-loaded','context','Only already-presented evidence is available before get_selected_context.');
          const unknown=ids.find(id=>!known.has(id)||(!selectedContextAvailable&&!visibleIds.has(id)));
          if (unknown) throw inputError('unknown-evidence-id','evidenceIds',`known evidence ID; ${unknown.slice(0,80)} is unavailable`,undefined,[...known.keys()].slice(0,32));
          result = { contextHash, evidence: ids.map(id => known.get(id)!), limitations: ["Retrieved records retain their original scope and authority."] };
        } else {
          if (searchDescriptorByName.has(d.name as ReasoningToolName) && input.host.reservesSearchAtDispatch!==true && !(['test_line','test_game_line'].includes(d.name) && args.analyzeFinal!==true))execution.reserveSearch();
          result = await input.host.execute(d.name as ReasoningToolName, { ...args, callId: options.toolCallId, contextHash }, controller.signal, execution);
          admittingEvidence = true;
          if (result.contextHash !== contextHash || result.callId !== options.toolCallId || result.tool !== d.name) throw new Error("cross-context-tool-result");
        }
        if (controller.signal.aborted) throw new Error("cancelled");
        admittingEvidence = true;
        for (const e of result.evidence) {
          if (e.contextHash !== contextHash || !e.id) throw new Error("cross-context-evidence");
          effectiveLicensesForRecord(e);
          const old = known.get(e.id);
          if (old && JSON.stringify(old) !== JSON.stringify(e)) throw new Error("evidence-identity-conflict");
        }
        for (const e of result.evidence) { known.set(e.id, e); visibleIds.add(e.id); }
        // Avoid repeating the data already carried by complete evidence records.
        const compact = { contextHash, evidence: result.evidence, limitations: result.limitations, scoreComparisonNotices:scoreComparisonNotices(visibleRecords()).filter(n=>n.observations.some(o=>result.evidence.some(e=>e.id===o.evidenceId))) };
        if ("recordedMainLine" in result) {
          const recorded = { ...compact, recordedMainLine: result.recordedMainLine, ...("recordedAnalysis" in result?{recordedAnalysis:result.recordedAnalysis}:{}) };
          Object.assign(run, { status: "completed", result: recorded, elapsedMs: performance.now() - start });
          trace("simple-tool", "output", run); return recorded;
        }
        const openingSourceContext = "tool" in result ? await theoryForTool(d.name, args, result) : undefined;
        if (controller.signal.aborted) throw new Error("cancelled");
        Object.assign(run, { status: "completed", result: { ...compact, ...(openingSourceContext ? {openingSourceContext} : {}) }, elapsedMs: performance.now() - start });
        trace("simple-tool", "output", run);
        const full = compactSimpleEngineResult(coverageEnabled ? planningEvidence(compact) : compact,input.materialFormat);
        const reused = coverageEnabled ? full : compactSimpleEngineResult(delivery.project(options.toolCallId, projectEnginePresentation(compact) as typeof compact),input.materialFormat);
        if(d.name==='retrieve_evidence')return compactSimpleEngineResult(compact,input.materialFormat,true);
        const projected=withOpeningSource(JSON.stringify(reused).length < JSON.stringify(full).length ? reused : full, openingSourceContext);
        return coverageEnabled ? {result:projected,investigation:explanationCoverage(input.bundle.context,visibleRecords(),review),recurring:recurringForTurn()}:projected;
      } catch (error) {
        if (admittingEvidence && !controller.signal.aborted) contractFailure = true;
        const detail=toolError(error);
        Object.assign(run, { status: "failed", ...detail, elapsedMs: performance.now() - start });
        trace("simple-tool", "error", run); return { ...detail, evidence: [], limitation: "No evidence acquired by this failed request." };
      } finally { input.onProgress?.("Reasoning about the chess evidence"); }
    } })]));
  try {
    for (let step = 0; step < (fixedEvidence ? 1 : SIMPLE_BUDGETS.maxModelCalls); step += 1) {
      if (controller.signal.aborted) throw new Error("cancelled-or-time-budget");
      const remaining = budgets.maxOutputTokens - outputTokens;
      let final = toolInputGuard.repeatedFailures>0 || fixedEvidence || step === budgets.maxModelCalls - 1 || timeToFinish() || remaining <= budgets.maxOutputTokensPerCall;
      if(final && !fixedEvidence) completionReason = toolInputGuard.repeatedFailures>0 ? 'repeated-invalid-tool-input' : timeToFinish() ? 'time' : remaining <= budgets.maxOutputTokensPerCall ? 'output' : 'model-calls';
      if(coverageEnabled && final)messages.push({role:'user',content:JSON.stringify({investigationLimit:explanationCoverage(input.bundle.context,visibleRecords(),review),instruction:'Answer now from acquired evidence. Explicitly narrow any materially unresolved mechanism; do not present incomplete coverage as established.'})});
      let modelMessages = input.evidenceCompaction === 'baseline' ? messages : shareEvidenceMessages(messages);
      let sharedEvidence = input.evidenceCompaction !== 'baseline' && hasSharedEvidence(modelMessages);
      let encoded = JSON.stringify(modelMessages).includes('simple-engine-evidence/1');
      let reusedFacts = JSON.stringify(messages).includes('"$priorFact"');
      let system = input.policy?.system({encoded,reusedFacts,sharedEvidence,final,purposeGuidance:input.purposeGuidance,searchBreadthGuidance:input.searchBreadthGuidance,boardAnalysisGuidance:input.boardAnalysisGuidance,explanationCoverage:coverageEnabled,answerComposition});
      const requestBytes = new TextEncoder().encode((system ?? "") + JSON.stringify(modelMessages) + JSON.stringify(final ? [] : definitions)).length;
      if (requestBytes > budgets.maxRequestBytes * 0.75) {
        final = true; completionReason = 'context';
        modelMessages = [{role:'user',content:JSON.stringify(completionPacket(input.question ?? input.bundle.question, visibleRecords(), gameView, omitSelectedContext ? undefined : input.bundle.context, {...(standardReference?{standardReference}:{}),playerPerspective:input.playerPerspective, selectionContext:omitSelectedContext ? "omitted" : "included", evidenceRouting:{answerComposition}, ...(coverageEnabled ? {investigation:explanationCoverage(input.bundle.context,visibleRecords(),review)} : {})}))}];
        sharedEvidence=false; encoded=false; reusedFacts=false;
        system=input.policy?.system({encoded,reusedFacts,sharedEvidence,final:true,purposeGuidance:input.purposeGuidance,answerComposition});
      }
      trace('simple-request-budget','output',{step:step+1,preCompletionBytes:requestBytes,
        sentEstimatedBytes:new TextEncoder().encode((system??'')+JSON.stringify(modelMessages)+JSON.stringify(final?[]:definitions)).length,
        maxRequestBytes:budgets.maxRequestBytes,contextThresholdBytes:budgets.maxRequestBytes*0.75,
        originalMessageCount:messages.length,sentMessageCount:modelMessages.length,
        historyReplaced:completionReason==='context',completionReason:completionReason??null,final,
        ...(completionReason==='context'?{completionOmissions:(()=>{const p=JSON.parse(String(modelMessages[0].content));return {omittedRecords:p.omittedRecords,omittedEvidenceIds:p.omittedEvidenceIds,omittedGameRecord:p.omittedGameRecord,omittedContext:p.omittedContext};})()}: {})});
      if (new TextEncoder().encode((system ?? "") + JSON.stringify(modelMessages)).length > budgets.maxRequestBytes) {
        completionReason='context';answer=evidenceFallback(visibleRecords(),searchCount,'',input.question ?? input.bundle.question,input.bundle.context,selectedContextAvailable);break;
      }
      // The final allowance is reserved before investigation can consume it.
      const maxOutputTokens = final ? budgets.maxOutputTokensPerCall : Math.min(budgets.maxOutputTokensPerCall, Math.max(1,remaining-budgets.maxOutputTokensPerCall));
      if(final) input.onProgress?.("Summarizing the evidence collected");
      trace("simple-model", "input", { system: system ?? "Server-owned policy: simple-policy/1", messages: observableTraceMessages(modelMessages), tools: final ? [] : definitions,
        maxOutputTokens, toolChoice: final ? "none" : "auto", step, reasoning: { effort: input.effort ?? "medium", exclude: false } });
      const start = performance.now();
      const suppliedOpeningSources=openingSourcesInMessages(modelMessages,knownOpeningPages);
      const result = await invokeAnswerTurn(input.connector, { system, messages: modelMessages, tools: final ? undefined : tools,
        providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"], reasoningEffort: input.effort ?? "medium" } },
        toolChoice: final ? "none" : "auto", maxOutputTokens, maxRetries: 0, abortSignal: controller.signal,
        ...(fixedEvidence ? {fixedEvidenceDiscardTools:tools} : {}) });
      for(const credit of suppliedOpeningSources)openingSources.set(openingSourceKey(credit),credit);
      const reportedOutput = subagentEvaluation ? undefined : result.usage.outputTokens;
      const inputUsage=result.usage.inputTokens;
      if(typeof inputUsage === "number" && Number.isFinite(inputUsage) && inputUsage>=0)reportedInputTokens+=inputUsage;else unmeteredInputCalls++;
      const outputReported = typeof reportedOutput === "number" && Number.isFinite(reportedOutput) && reportedOutput >= 0;
      if(outputReported)reportedOutputTokens+=reportedOutput;else {unmeteredCalls++;outputBudgetReservation+=maxOutputTokens;}
      const diagnostic = { stage: "simple-model", inputTokens: result.usage.inputTokens || 0,
        outputTokens: typeof reportedOutput === "number" && Number.isFinite(reportedOutput) && reportedOutput >= 0 ? reportedOutput : maxOutputTokens,
        latencyMs: performance.now() - start, finishReason: result.finishReason, ...(!outputReported ? {metering:"unavailable" as const, outputBudgetReservation:maxOutputTokens} : {}) };
      diagnostics.push(diagnostic); outputTokens += diagnostic.outputTokens;
      if (contractFailure) { failure = "tool-evidence-contract-failed"; break; }
      trace("simple-model", "output", { ...diagnostic, text: result.text, toolCalls: result.toolCalls,
        messages: observableTraceMessages(result.response.messages), ...simpleUsageForTrace(result.usage,result.providerMetadata,result.response.headers) });
      // Preserve provider-owned metadata unchanged in memory, never reconstruct it
      // from the sanitized trace or persist its hidden reasoning contents.
      messages.push(...result.response.messages);
      delivery.commit();
      if (!result.toolCalls.length) {
        answer = result.text.trim();
        if (result.finishReason === "length" || !answer) {
          completionReason = result.finishReason === "length" ? 'output-truncated' : 'empty-answer';
          answer=evidenceFallback(visibleRecords(),searchCount,answer,input.question ?? input.bundle.question,input.bundle.context,selectedContextAvailable);
        }
        break;
      }
    }
    if (!answer && !failure) { completionReason="no-final-answer";answer=evidenceFallback(visibleRecords(),searchCount,'',input.question ?? input.bundle.question,input.bundle.context,selectedContextAvailable); }
  } catch (error) {
    failure = controller.signal.aborted ? "cancelled-or-time-budget" : error instanceof Error && /budget/.test(error.message) ? error.message : "provider-interface-failed";
    failureDetails = failureFromError(error, controller.signal.aborted ? (input.signal?.aborted ? "cancelled" : "request_timeout") : failure.replaceAll("-", "_"));
    trace("simple-model", "error", { failure, error: failureDetails, ...(error && typeof error === "object" && "serviceRouting" in error && error.serviceRouting ? {serviceRouting:error.serviceRouting} : {}), completedCalls: diagnostics.length });

    if (!input.signal?.aborted && !contractFailure && diagnostics.length > 0 && !actionable.has(failureDetails.code)) {
      completionReason=failure; answer=evidenceFallback(visibleRecords(),searchCount,answer,input.question ?? input.bundle.question,input.bundle.context,selectedContextAvailable);
      failure=null; failureDetails=undefined;
    }
  } finally {  input.signal?.removeEventListener("abort", abort); }
  // One bounded, tool-free recovery for a failed/empty/truncated response. Never
  // retry account errors or cancellation. A separate single recovery slot may
  // exceed the soft normal-call/output targets to deliver a final summary.
  if (!failure && !input.signal?.aborted && !fixedEvidence
    && ['output-truncated','empty-answer','no-final-answer','provider-interface-failed'].includes(completionReason ?? '')) {
    const recoveryMessages:ModelMessage[]=[{role:'user',content:JSON.stringify(completionPacket(input.question ?? input.bundle.question,visibleRecords(),gameView,omitSelectedContext?undefined:input.bundle.context,{...(standardReference?{standardReference}:{}),playerPerspective:input.playerPerspective,selectionContext:omitSelectedContext?'omitted':'included',evidenceRouting:{answerComposition}}))}];
    const system=input.policy?.system({encoded:false,reusedFacts:false,final:true,answerComposition});
    if(new TextEncoder().encode((system??'')+JSON.stringify(recoveryMessages)).length <= budgets.maxRequestBytes) {
      input.onProgress?.('Completing a concise summary');
      const start=performance.now();
      trace('simple-model','input',{system:system??'Server-owned policy: simple-policy/1',messages:observableTraceMessages(recoveryMessages),tools:[],toolChoice:'none',maxOutputTokens:budgets.maxOutputTokensPerCall,recovery:true});
      try {
        const result=await invokeAnswerTurn(input.connector, {system,messages:recoveryMessages,toolChoice:'none',maxOutputTokens:budgets.maxOutputTokensPerCall,maxRetries:0,abortSignal:input.signal,
          providerOptions:{openai:{store:false,include:['reasoning.encrypted_content'],reasoningEffort:input.effort??'medium'}}});
        const recoveryInput=result.usage.inputTokens;
        if(typeof recoveryInput === "number" && Number.isFinite(recoveryInput) && recoveryInput>=0)reportedInputTokens+=recoveryInput;else unmeteredInputCalls++;
        const recoveryOutput=result.usage.outputTokens;
        const recoveryReported=typeof recoveryOutput === "number" && Number.isFinite(recoveryOutput) && recoveryOutput>=0;
        const used=recoveryReported?recoveryOutput:budgets.maxOutputTokensPerCall;
        if(recoveryReported)reportedOutputTokens+=used;else{unmeteredCalls++;outputBudgetReservation+=used;}
        const diagnostic={stage:'simple-model',inputTokens:result.usage.inputTokens??0,outputTokens:used,latencyMs:performance.now()-start,finishReason:result.finishReason};
        diagnostics.push(diagnostic);outputTokens+=used;
        trace('simple-model','output',{...diagnostic,recovery:true,text:result.text,...simpleUsageForTrace(result.usage,result.providerMetadata,result.response.headers)});
        if(result.text.trim() && result.finishReason!=='length') answer=result.text.trim();
      } catch(error) {
        const detail=failureFromError(error);
        trace('simple-model','error',{recovery:true,error:detail});
        if(actionable.has(detail.code)){failure=detail.code;failureDetails=detail;answer='';}
        if(input.signal?.aborted){failure='cancelled';failureDetails=failureFromError(error,'cancelled');answer='';}
      }
    }
  }
  const engineEvidenceStatus = searchesSucceeded > 0 ? 'available' as const
    : searchesFailed > 0 && searchesSucceeded + searchesFailed === searchCount ? 'unavailable' as const
    : searchCount > 0 ? 'unknown' as const : 'not-requested' as const;
  const engineLimitation = 'Engine analysis was unavailable for this answer, so evaluations and tactical lines have not been verified with Stockfish.';
  if (!failure && answer && engineEvidenceStatus === 'unavailable') answer = `${engineLimitation}\n\n${answer}`;
  let referenceValidation: ReturnType<typeof validateAnswerReferences>['referenceValidation'] & {supportingContinuations?: ReturnType<typeof visibleSupportLines>['additions']} | {status:'unavailable';reason:string};
  try {
    const validated = validateAnswerReferences(answer, input.bundle.context, visibleRecords(), acquiredMainLines.at(-1));
    const expanded = visibleSupportLines(validated.answer, input.bundle.context, visibleRecords(), acquiredMainLines.at(-1));
    const finalValidation = expanded.additions.length
      ? validateAnswerReferences(expanded.answer, input.bundle.context, visibleRecords(), acquiredMainLines.at(-1)) : validated;
    answer = finalValidation.answer;
    referenceValidation = {...finalValidation.referenceValidation,
      repairs:validated.referenceValidation.repairs, citationRepairs:validated.referenceValidation.citationRepairs,
      labelCorrections:validated.referenceValidation.labelCorrections,
      notationCorrections:[...new Set([...validated.referenceValidation.notationCorrections,...finalValidation.referenceValidation.notationCorrections])],
      supportingContinuations:expanded.additions};
  } catch {
    // Diagnostics must never discard an already completed paid answer. The
    // renderer retains its own admission checks and readable fallback.
    referenceValidation = {status:'unavailable',reason:'Reference validation could not complete; original answer retained.'};
  }
  trace('simple-reference-validation', 'output', referenceValidation);
  const engineSearches = {searchesUsed:searchCount,searchesSucceeded,searchesFailed,engineEvidenceStatus};
  trace('simple-engine-evidence', 'output', {...engineSearches,status:engineEvidenceStatus === 'unavailable' ? 'degraded' : engineEvidenceStatus});
  if(completionReason) trace("simple-completion","output",{reason:completionReason,hasAnswer:Boolean(answer),...engineSearches,toolCallsUsed:toolCount});
  return { preparationConsolidation:consolidatedPreparation.diagnostics, referenceValidation, completionReason, toolCallsUsed:toolCount, initialSearches, ...(coverageEnabled?{explanationCoverage:{...explanationCoverage(input.bundle.context,visibleRecords(),review),stopRepairs,reviewCount,qualificationRequested},recurringMotifs:explanationSummary(input.bundle.context,visibleRecords())}:{}),preparation: input.preparation, ...engineSearches, acquiredMainLines, status: failure ? "failure" as const : "diagnostic" as const, answer, failure, failureDetails, diagnostics, toolRuns,
    elapsedMs: performance.now() - started + preparationMs, initialEvidenceIds: [...initialPreparedEvidenceIds,...(omitSelectedContext?[]:[...new Set([...initial.evidence.map(e => e.id),...(selectedContextRecord?[selectedContextRecord.id]:[])])]), ...(!omitSelectedContext && input.boardAnalysis ? [input.boardAnalysis.record.id] : [])], presentedEvidenceIds: [...visibleIds],
    presentedEvidence: [...known.values()].filter(record => visibleIds.has(record.id)), openingSources:[...openingSources.values()],
    ...(subagentEvaluation ? {evaluationTransport:{...subagentEvaluation,metering:"unavailable",outputBudgetReserved:outputTokens}} : {}),
    usage: { inputTokens: diagnostics.reduce((n, d) => n + d.inputTokens, 0), outputTokens, metering:(unmeteredCalls||unmeteredInputCalls) ? "partly-unavailable" as const : "reported" as const, reportedOutputTokens:unmeteredCalls ? null : reportedOutputTokens, outputBudgetReservation, unmeteredCalls, reportedInputTokens:unmeteredInputCalls ? null : reportedInputTokens, unmeteredInputCalls }, limitations: [SIMPLE_DISCLOSURE, ...(engineEvidenceStatus === 'unavailable' ? [engineLimitation] : [])] };
}
