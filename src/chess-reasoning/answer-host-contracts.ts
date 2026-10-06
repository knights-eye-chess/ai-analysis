import type { ReasoningPositionContext } from './poc-contracts';
import type { QuestionRoutingDecision } from './question-routing';
import type { WikibooksContextResult, WikibooksTarget } from './opening-source-contracts';
export type RecordedMoveAnalysis = { version: string; fenBefore: string; fenAfter: string; moveUci: string; engine: string; actualDepth: number; requestedDepth: number; classifierVersion: number; classification: string; beforeCp: number | null; afterCp: number | null; lossCp: number | null; mateBefore: number | null; mateAfter: number | null };
export type RecordedMainLine = { selectedAtStart?: boolean; startFen: string; moves: Array<{ uci: string; san: string; edgeId: string; analysis?: RecordedMoveAnalysis }>; selectedIndex: number; totalPlies: number; truncated: boolean; };

export type AnswerSelection = {deliveryId:string;selectionKey:string;edgeId:string;context:ReasoningPositionContext;existingAnalysis:unknown};
export type AnswerRoutingPreparation = {decision:QuestionRoutingDecision;mainLine?:RecordedMainLine;omitSelectedContext:boolean;elapsedMs:number;question:string;selectionKey:string;deliveryId:string};
export type AnswerHistoryPort = {getMainLine?:(selected:AnswerSelection,signal?:AbortSignal)=>Promise<RecordedMainLine>;refreshContext?:(selected:AnswerSelection,signal?:AbortSignal)=>Promise<{existingAnalysis:unknown}>};
export type AnswerOpeningSession = {initial:(signal?:AbortSignal)=>Promise<WikibooksContextResult>;gameReview:(line:RecordedMainLine,signal?:AbortSignal)=>Promise<WikibooksContextResult>;lookup:(targets:WikibooksTarget[],signal?:AbortSignal,root?:ReasoningPositionContext)=>Promise<WikibooksContextResult>};
