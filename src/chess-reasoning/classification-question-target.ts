import type { ReasoningPositionContext } from './poc-contracts';
import {hasMoveClassificationQuestion,type QuestionRoutingDecision} from './question-routing';

const normalizedSan=(san:string)=>san.replace(/[+#?!]+$/,'');
/** Question-only notation extraction; these are references, not verified moves. */
export function classificationQuestionMoveReferences(question:string) {
  const pattern=/(?<![A-Za-z0-9])(?:(\d+)\s*(\.{1,3}|…)\s*)?(O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x?[a-h]?[1-8](?:=[QRBN])?)[+#]?(?![A-Za-z0-9])/g;
  return [...question.matchAll(pattern)].map(match=>({san:normalizedSan(match[3]),moveNumber:match[1]?Number(match[1]):null,color:match[2]?(match[2]==='.'?'w':'b'):null}));
}
/** Resolve wording against frozen context AFTER Jev; never change board selection. */
export function classificationTargetAtSelection(decision:QuestionRoutingDecision,question:string,context:ReasoningPositionContext) {
  if(!hasMoveClassificationQuestion(decision))return {applies:false,resolution:'no-classification'};
  if(context.kind==='position'||!context.moveUci)return {applies:false,resolution:'no-played-selection'};
  const reference=decision.answers?.classification_reference?.choice;
  if(reference==='selection_relative')return {applies:true,resolution:'selection-relative'};
  // An affirmative classification intent plus the existing local-reference head
  // can resolve a contradictory/missing secondary head, only without named moves.
  const localReference=decision.answers?.local_reference;
  if((!reference||reference==='none')&&localReference?.type==='choice'&&localReference.choice==='yes'&&classificationQuestionMoveReferences(question).length===0)
    return {applies:true,resolution:'unnamed-local-classification'};
  if(reference!=='named_move')return {applies:false,resolution:reference==='other_relative'?'other-relative':'unresolved-reference'};
  const references=classificationQuestionMoveReferences(question);
  const unique=[...new Map(references.map(ref=>[JSON.stringify(ref),ref])).values()];
  // Multiple distinct named moves require model-directed disambiguation. Never
  // silently make an alternative or quoted/other named move the selected target.
  if(unique.length!==1)return {applies:false,resolution:'ambiguous-named-reference',references};
  const ref=unique[0],fields=context.fenBefore.split(' ');
  const matches=ref.san===normalizedSan(context.moveSan)&&(!ref.moveNumber||ref.moveNumber===Number(fields[5]))&&(!ref.color||ref.color===fields[1]);
  return {applies:matches,resolution:matches?'named-selected-move':'named-other-move',references};
}
