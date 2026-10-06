/** KE-REASON-024: question-only Jev routing contract. */
export const QUESTION_ROUTING_VERSION = "jev-r17-move-classification-20261003";

export const REVIEW_SUBJECTS = ['self','opponent','white','black','both','unspecified'] as const;
export const ANSWER_SCOPES = ['move_explanation','position_analysis','game_review','general','mixed'] as const;
export type AnswerScope = typeof ANSWER_SCOPES[number];
export type AnswerScopeAnswer = {type:'choice';choice:AnswerScope;confidence?:number;probabilities?:Partial<Record<AnswerScope,number>>};
export type ReviewSubject = typeof REVIEW_SUBJECTS[number];
export type ReviewSubjectAnswer = {type:'choice';choice:ReviewSubject;confidence?:number;probabilities?:Partial<Record<ReviewSubject,number>>};
const reviewSubjectQuestion = {
  type:'choice',
  instructions:"Whose play is the user asking to assess across a game or phase? Find the subject of that assessment, even if expressed as past decisions to improve rather than the word review. Ignore separate local-position requests and quoted or excluded instructions. Ownership of a game alone is not a player restriction. If the question explicitly identifies the reviewed player's color, choose white or black rather than self or opponent. Conflicting active review subjects must not select one player.",
  criteria:{
    self:"Assessment of the user's own performance or decisions: their errors, what they did wrong, or what they should have done differently across the game. This personal assessment can accompany a request to go through their game. No assessment of the other player's decisions is requested, and the question does not explicitly identify the user's color.",
    opponent:"The user asks to assess their opponent's play, mistakes or decisions, without requesting review of their own play. The question does not explicitly identify which color that opponent played.",
    white:"The requested review concerns White's decisions only, whether named directly or identified as the user/opponent by an explicit statement of who played which color. Color mentions that merely describe the opponent or another local question do not count.",
    black:"The requested review concerns Black's decisions only, whether named directly or identified as the user/opponent by an explicit statement of who played which color. Color mentions that merely describe the opponent or another local question do not count.",
    both:"The across-game/phase review explicitly covers both players, or contains conflicting review subjects that cannot be resolved to one player. A separate question about a single move or piece does not add a player to this review's scope.",
    unspecified:"No assessment across multiple played decisions is requested, or no player's decisions are singled out. An overall review of the game, my game or our opening alone has no player restriction. An additional request to assess the user's own decisions DOES specify self instead.",
  },
} as const;

const independentCriteria = {
  yes: "Every active request is independent of the board selection: game-record facts (including final moves), review of a game or phase (including endgames), general knowledge or language, or an explicitly numbered historical move and its alternatives. Quoted or excluded current-position references do not count.",
  no: "At least one active request is about the current board, selected move, next reply, or continuation relative to it; or refers to an unidentified move or prior answer. A mixed game-review/current-position question belongs here.",
};

const questions = {
  independent: {
    type: "choice", instructions: "Can all active requests be answered using the game record or general knowledge, without knowing which turn the viewer selected?", criteria: independentCriteria,
  },
  independent_noul: {
    type: "noul", instructions: "Is the user asking only about subjects identifiable independently of the selected move?",
    criteria: { true: independentCriteria.yes, false: independentCriteria.no },
  },
  board_guard: {
    type: "choice", instructions: "Does the user actively ask about the board position currently displayed?",
    criteria: {
      yes: "An active request for its evaluation, material, threats, legal moves, plans, or another property of the current position. Excluding discussion of the selected move does not exclude the board.",
      no: "Only game history, phase review, an explicitly numbered historical turn, general knowledge, or discussion/translation of quoted text. No active request about the current board.",
    },
  },
  review_only: {
    "type": "choice",
    "instructions": "Is the user's entire request a review of how they played across a game or a phase of that game?",
    "criteria": {
      "yes": "Assess their play across the opening, middlegame, endgame or whole game. Evaluate performance, identify mistakes or missed chances, or give lessons from that play. No additional request about the selected move, the current board, or what to play next.",
      "no": "A specific move or current position is being discussed, including a mixed request combining a game review with a selected-move explanation, current-position assessment, next move or continuation. General chess advice without reviewing their played game is also no."
    }
  },
  local_reference: {
    "type": "choice",
    "instructions": "Does answering the user's active question require identifying a move or position referred to without an explicit game move number?",
    "criteria": {
      "yes": "The question asks about this move, this position, here, now, a next move, an unnamed alternative, or a reference to a previous answer. Include mixed requests even if they also mention game history or reviewing the opening. A question like why this is losing needs the referenced position.",
      "no": "Every active request is about the whole game, a game phase, general knowledge, or an explicitly numbered historical move. Mentions of the current board that are quoted or explicitly excluded are not active requests."
    }
  },
  game_record: {
    "type": "choice",
    "instructions": "Does the user ask what actually happened in this game, including which moves were played?",
    "criteria": {
      "yes": "The user asks for actual game events, actual subsequent play, or whether/when a move was played.",
      "no": "The user is not asking to retrieve actual game events or played moves."
    }
  },
  game_context: {
    "type": "choice",
    "instructions": "Does answering the user require their recorded game, beyond the selected move and its immediately surrounding positions?",
    "criteria": {
      "yes": "The answer depends on played game history: actual events or later play, review of a game or phase, an explicitly numbered historical move, or advice and variations specific to the opening played in this game. Include coaching requests grounded in their game even when they do not explicitly ask to retrieve moves.",
      "no": "The current position or selected move alone is sufficient, or the request is general chess knowledge, translation, or unrelated to the played game. A named opening alone without a reference to their game does not require game history. Comparing possible moves in the selected position is a local question, unless another part of the request needs game history."
    }
  },
  game_review: {
    type: "choice", instructions: "Is a review of play across the game or a phase explicitly requested?",
    criteria: {
      yes: "Review multiple decisions, find mistakes across a phase or the game, or recommend lessons from that play. An explicit question about how an earlier phase went still counts when paired with next-move advice. A comprehensive review of the full game counts even without mentioning mistakes or personal performance.",
      no: "No broad review is requested. Mentioning past mistakes while asking what to do now, or asking about just one move, is not a broad review. Retrieving facts, statistics or played moves without evaluating decisions is not a review. Evaluating only one hypothetical alternative is not a phase review. Opening identification or general planning advice without assessing played decisions is not a review.",
    },
  },
  selected_anchor: {
    type: "choice",
    instructions: "Is any part of the request about the currently selected chess position or an unidentified local move? Classify the active request, not quoted or explicitly excluded text.",
    criteria: {
      yes: "The displayed board, this move, an unnumbered move judged against the engine, an unnamed alternative, what to play from here, or an unresolved reference to previous analysis. General advice alongside a local question still counts.",
      no: "Only a whole game, a game phase, a move identified by its turn number, actual game events, or a self-contained general topic. A numbered move anchors its consequences and replies too. This includes numbered historical moves written with non-English piece notation.",
    },
  },
  numbered_move_target: {
    type: "choice",
    instructions: "Is an actual game turn number attached to the target move, separately from its destination square? Ignore quoted or excluded requests.",
    criteria: {
      yes: "A turn number precedes a period and move, as in 5.Nxe5 or 12...Nd4, or prose explicitly says bishop move on turn twelve. The user asks about that identified move, its alternatives or consequences.",
      no: "A square rank is NOT a turn number: Ne6, Na5, a5 and d4 are unnumbered moves. Quantities of plies and ranges of turns are not numbered target moves. Numbered text merely quoted for translation does not count.",
    },
  },
  played_opening: {
    type: "choice",
    instructions: "Does the user actively ask to identify or teach the opening system or sequence played in their game? Ignore quoted or excluded requests.",
    criteria: {
      yes: "Identify the played opening, teach this opening or our opening, give its overall main lines, or coach the opening phase of their game. The request must actually refer to an opening or opening phase.",
      no: "Only current-position advice, best replies or continuations from the current point. An opening name merely framing a particular move is insufficient. Generic named-opening theory, or opening words inside text being translated, also do not count.",
    },
  },
  retrospective_review: {
    type: "choice",
    instructions: "Does the user request feedback on how they played across a game or a phase? Classify the active request, not quoted or explicitly excluded text.",
    criteria: {
      yes: "Review actual play, diagnose recurring mistakes, or explain how their decisions across the opening, middlegame, endgame or game could have been better. This can be part of a mixed request.",
      no: "Only one move or position; theory, prospective continuations, hypothetical traps or typical future mistakes. A walkthrough of possible replies is not feedback on played decisions.",
    },
  },
} as const;

const answerScopeQuestion = {
  type:'choice',
  instructions:"What is the main task of the user's active request? Classify its requested answer, not the selected board, available game history, routing needs, or quoted/excluded text. A move explanation requires a specific move actually played, including an identified historical game move; a hypothetical candidate from the current position is position analysis. Choose mixed if a move explanation is combined with a substantial whole-game, position, or other independent task.",
  criteria:{
    move_explanation:'Explain or evaluate one specific played move, selected now or identified from the recorded game, and its pertinent alternatives or continuations.',
    position_analysis:'Assess a current or starting position, legal candidates, plans or next moves without a specific played target move.',
    game_review:'Review decisions or play across the whole recorded game or a phase, even when a selected move happens to be available.',
    general:'Answer a factual, rules, opening theory, translation or other question that is not a played-move explanation, position analysis or game review.',
    mixed:'Multiple substantial tasks have different scopes; do not force one played-move structure over the complete answer.',
  },
} as const;

const moveClassificationQuestion = {
  type:'choice',
  instructions:"Does ANY active part of the question ask to explain, justify, challenge or reassess the quality classification of a PLAYED move? Include mixed questions and played moves identified by SAN, game move number, this move, or previous move. You have only the question: do not infer whether a named or numbered move is selected now or historical. Ignore quoted or expressly excluded requests.",
  criteria:{
    yes:"At least one active request asks why or whether a played move deserves a quality label: forced, brilliant, great, interesting, best, good, okay, dubious, mistake, missed opportunity or blunder. Why is this the best move in this position, why is 14.Qg4 great, and why was my opponent's previous move a blunder all count. The request can be one part of a mixed question.",
    no:"No active played-move quality-classification request. Only move intention, plans, threats, position evaluation, prospective hypothetical candidates, opening lines, general label definitions, translation of quoted classification questions, expressly excluded label explanations, or a label mentioned merely as background.",
  },
} as const;
const classificationReferenceQuestion = {
  type:'choice',
  instructions:"How is the target of the ACTIVE PLAYED-MOVE CLASSIFICATION request expressed? Describe only the wording, not game facts or which move is selected. Examine classification requests separately from unrelated requests in a mixed question. If ANY active classification request explicitly refers to this/current/selected move or an unnamed local played move, choose selection_relative even alongside named-move questions. Unrelated local plans or next-move requests do not count as selection-relative classification requests. Ignore quoted and expressly excluded text.",
  criteria:{
    selection_relative:"An active classification request says this move, the current/selected move, this was a mistake, or otherwise concerns an unnamed local played move. Takes precedence if there is also a named or previous-move classification request. Compare 14.Qg4 with 14.Qh5, and explain why this selected move is marked a mistake is selection_relative.",
    named_move:"Active played-move classification requests name a move by SAN, optionally with a game move number, and no separate selection-relative classification request exists. Why is 14.Qg4 great, and what should I play next here is named_move: only the plans request is local. The number does not tell you whether that move is currently selected.",
    other_relative:"Active played-move classification requests identify a previous move, opponent's last move or another relative played move without explicit SAN, with no selection-relative or named-move classification request. This describes the reference wording, not its resolved game position.",
    none:"No active played-move classification request: only definitions, quoted or excluded label questions, prospective hypothetical moves, move intention, position evaluation, plans, opening lines or labels mentioned as background.",
  },
} as const;
export const CLASSIFICATION_REFERENCES=['selection_relative','named_move','other_relative','none'] as const;
export type ClassificationReference=typeof CLASSIFICATION_REFERENCES[number];
export type ClassificationReferenceAnswer={type:'choice';choice:ClassificationReference;confidence?:number;probabilities?:Partial<Record<ClassificationReference,number>>};
/** Saved r16 responses remain readable; these legacy heads are never requested or used. */
export const CLASSIFICATION_TARGETS=['selected_move','other_move','none'] as const;
export type ClassificationTarget=typeof CLASSIFICATION_TARGETS[number];
export type ClassificationTargetAnswer={type:'choice';choice:ClassificationTarget;confidence?:number;probabilities?:Partial<Record<ClassificationTarget,number>>};

export type QuestionRoutingAnswer = {type:"choice";choice:"yes"|"no";confidence?:number;probabilities?:Partial<Record<"yes"|"no",number>>} | {type:"noul";noul:number};
export type QuestionRoutingAnswers = Record<keyof typeof questions,QuestionRoutingAnswer> & {review_subject?:ReviewSubjectAnswer;answer_scope?:AnswerScopeAnswer;current_classification?:QuestionRoutingAnswer;classification_target?:ClassificationTargetAnswer;move_classification?:QuestionRoutingAnswer;classification_reference?:ClassificationReferenceAnswer};
export type QuestionRoutingDecision = {
  version:string;
  status:"classified"|"fallback";
  omitSelectedContext:boolean;
  includeGameRecord:boolean;
  gameRecordTrigger?:'starting-position';
  reviewGame:boolean;
  reviewSubject?:ReviewSubject;
  reason?:string;
  answers?:QuestionRoutingAnswers;
  usage?:{cost?:number|null;prompt_tokens?:number;completion_tokens?:number;total_tokens?:number;input_tokens?:number;output_tokens?:number};
  providerLatencyMs?:number;
};

export function makeQuestionRoutingRequest(question:string) {
  if(typeof question!=="string" || !question.trim() || question.length>8000) throw new Error("Invalid routing question.");
  // New objects per request prevent a caller from modifying the frozen template.
  return {model:"typesafe/jev-1.13",state:{question},questions:structuredClone({...questions,review_subject:reviewSubjectQuestion,answer_scope:answerScopeQuestion,move_classification:moveClassificationQuestion,classification_reference:classificationReferenceQuestion})};
}

const record=(value:unknown):value is Record<string,unknown> => value!==null && typeof value==="object" && !Array.isArray(value);
const probability=(value:unknown):value is number => typeof value==="number" && Number.isFinite(value) && value>=0 && value<=1;
const keysWithin=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
/** Preserve validated legacy heads even if the additive subject head is unavailable. */
export function parseQuestionRoutingAnswers(value:unknown):QuestionRoutingAnswers|null {
  if(!record(value) || !record(value.answers) || !keysWithin(value.answers,[...Object.keys(questions),'review_subject','answer_scope','current_classification','classification_target','move_classification','classification_reference'])) return null;
  const parsed:Record<string,QuestionRoutingAnswer>={};
  for(const id of Object.keys(questions) as Array<keyof typeof questions>) {
    const answer=value.answers[id];
    if(!record(answer)) return null;
    if(id==="independent_noul") {
      if(answer.type!=="noul" || !probability(answer.noul) || !keysWithin(answer,["type","noul"])) return null;
      parsed[id]={type:"noul",noul:answer.noul};
    } else {
      if(answer.type!=="choice" || (answer.choice!=="yes" && answer.choice!=="no") || !keysWithin(answer,["type","choice","confidence","probabilities"])) return null;
      if(answer.confidence!==undefined && !probability(answer.confidence)) return null;
      if(answer.probabilities!==undefined && (!record(answer.probabilities) || !keysWithin(answer.probabilities,["yes","no"])
        || Object.values(answer.probabilities).some(value=>!probability(value)))) return null;
      parsed[id]={type:"choice",choice:answer.choice,
        ...(answer.confidence===undefined?{}:{confidence:answer.confidence as number}),
        ...(answer.probabilities===undefined?{}:{probabilities:answer.probabilities as Partial<Record<"yes"|"no",number>>})};
    }
  }
  const result=parsed as QuestionRoutingAnswers;
  const subject=value.answers.review_subject;
  if(record(subject) && subject.type==='choice' && REVIEW_SUBJECTS.includes(subject.choice as ReviewSubject)
    && keysWithin(subject,['type','choice','confidence','probabilities'])
    && (subject.confidence===undefined||probability(subject.confidence))
    && (subject.probabilities===undefined||record(subject.probabilities)&&keysWithin(subject.probabilities,REVIEW_SUBJECTS)
      && Object.values(subject.probabilities).every(probability))) {
    result.review_subject={type:'choice',choice:subject.choice as ReviewSubject,
      ...(subject.confidence===undefined?{}:{confidence:subject.confidence as number}),
      ...(subject.probabilities===undefined?{}:{probabilities:subject.probabilities as Partial<Record<ReviewSubject,number>>})};
  }
  const scope=value.answers.answer_scope;
  if(record(scope) && scope.type==='choice' && ANSWER_SCOPES.includes(scope.choice as AnswerScope)
      && keysWithin(scope,['type','choice','confidence','probabilities'])
      && (scope.confidence===undefined||probability(scope.confidence))
      && (scope.probabilities===undefined||record(scope.probabilities)&&keysWithin(scope.probabilities,ANSWER_SCOPES)
        && Object.values(scope.probabilities).every(probability))) {
    result.answer_scope={type:'choice',choice:scope.choice as AnswerScope,
      ...(scope.confidence===undefined?{}:{confidence:scope.confidence as number}),
      ...(scope.probabilities===undefined?{}:{probabilities:scope.probabilities as Partial<Record<AnswerScope,number>>})};
  }
  const classification=value.answers.current_classification;
  if(record(classification) && classification.type==='choice'
    && (classification.choice==='yes'||classification.choice==='no')
    && keysWithin(classification,['type','choice','confidence','probabilities'])
    && (classification.confidence===undefined||probability(classification.confidence))
    && (classification.probabilities===undefined||record(classification.probabilities)
      && keysWithin(classification.probabilities,['yes','no'])
      && Object.values(classification.probabilities).every(probability))) {
    result.current_classification={type:'choice',choice:classification.choice,
      ...(classification.confidence===undefined?{}:{confidence:classification.confidence as number}),
      ...(classification.probabilities===undefined?{}:{probabilities:classification.probabilities as Partial<Record<'yes'|'no',number>>})};
  }
  const target=value.answers.classification_target;
  if(record(target) && target.type==='choice' && CLASSIFICATION_TARGETS.includes(target.choice as ClassificationTarget)
    && keysWithin(target,['type','choice','confidence','probabilities'])
    && (target.confidence===undefined||probability(target.confidence))
    && (target.probabilities===undefined||record(target.probabilities)
      && keysWithin(target.probabilities,CLASSIFICATION_TARGETS)
      && Object.values(target.probabilities).every(probability))) {
    result.classification_target={type:'choice',choice:target.choice as ClassificationTarget,
      ...(target.confidence===undefined?{}:{confidence:target.confidence as number}),
      ...(target.probabilities===undefined?{}:{probabilities:target.probabilities as Partial<Record<ClassificationTarget,number>>})};
  }
  const moveClassification=value.answers.move_classification;
  if(record(moveClassification) && moveClassification.type==='choice'
    && (moveClassification.choice==='yes'||moveClassification.choice==='no')
    && keysWithin(moveClassification,['type','choice','confidence','probabilities'])
    && (moveClassification.confidence===undefined||probability(moveClassification.confidence))
    && (moveClassification.probabilities===undefined||record(moveClassification.probabilities)
      && keysWithin(moveClassification.probabilities,['yes','no'])
      && Object.values(moveClassification.probabilities).every(probability))) {
    result.move_classification={type:'choice',choice:moveClassification.choice,
      ...(moveClassification.confidence===undefined?{}:{confidence:moveClassification.confidence as number}),
      ...(moveClassification.probabilities===undefined?{}:{probabilities:moveClassification.probabilities as Partial<Record<'yes'|'no',number>>})};
  }
  const reference=value.answers.classification_reference;
  if(record(reference) && reference.type==='choice' && CLASSIFICATION_REFERENCES.includes(reference.choice as ClassificationReference)
    && keysWithin(reference,['type','choice','confidence','probabilities'])
    && (reference.confidence===undefined||probability(reference.confidence))
    && (reference.probabilities===undefined||record(reference.probabilities)
      && keysWithin(reference.probabilities,CLASSIFICATION_REFERENCES)
      && Object.values(reference.probabilities).every(probability))) {
    result.classification_reference={type:'choice',choice:reference.choice as ClassificationReference,
      ...(reference.confidence===undefined?{}:{confidence:reference.confidence as number}),
      ...(reference.probabilities===undefined?{}:{probabilities:reference.probabilities as Partial<Record<ClassificationReference,number>>})};
  }
  return result;
}

/** Unmeasured, ambiguous, legacy and fallback routes never enable the move-only suffix. */
export function moveSectionScope(decision:QuestionRoutingDecision):'move-explanation'|'none' {
  if(decision.status!=='classified')return 'none';
  const scope=decision.answers?.answer_scope;
  const score=scope?.probabilities?.move_explanation;
  return scope?.choice==='move_explanation' && typeof score==='number' && score>=0.75
    && Object.entries(scope.probabilities??{}).every(([key,p])=>key==='move_explanation'||p<score)
    ? 'move-explanation' : 'none';
}

export function classifyReviewSubject(answers:QuestionRoutingAnswers):ReviewSubject {
  const answer=answers.review_subject;
  const selected=answer?.probabilities?.[answer.choice]??0;
  return answer && selected>=0.75 && Object.entries(answer.probabilities??{})
    .every(([key,p])=>key===answer.choice||p<selected) ? answer.choice : 'unspecified';
}

export function classifyQuestionRoutingAnswers(answers:QuestionRoutingAnswers):Pick<QuestionRoutingDecision,"omitSelectedContext"|"includeGameRecord"|"reviewGame"> {
  const local=answers.local_reference;
  // Preserve the historical r8 omission and review signals as the baseline.
  const retainLocal=local.type!=="choice" || local.probabilities?.yes===undefined
    || (local.choice==="yes" && local.probabilities.yes>=0.85);
  const reviewOnly=answers.review_only;
  const independentReview=reviewOnly.type==="choice" && reviewOnly.choice==="yes" && (reviewOnly.probabilities?.yes??0)>=0.85;
  const independence=independentReview || (answers.independent as {choice:"yes"|"no"}).choice==="yes"
    || (answers.independent_noul as {noul:number}).noul>0.5;
  const board=answers.board_guard as {choice:"yes"|"no";probabilities?:{yes?:number}};
  const historicalOmission=!retainLocal && independence && board.choice==="no";
  const selected=answers.selected_anchor as {choice:"yes"|"no";probabilities?:{yes?:number;no?:number}};
  const strong=(id:"numbered_move_target"|"played_opening"|"review_only"|"game_context"|"game_review"|"retrospective_review",threshold:number)=>{
    const answer=answers[id] as {choice:"yes"|"no";probabilities?:{yes?:number}};
    return answer.choice==="yes" && (answer.probabilities?.yes??0)>=threshold;
  };
  const selectedGuard=(answers.move_classification?.type==='choice' && answers.move_classification.choice==='yes' && answers.classification_reference?.choice==='selection_relative') || selected.probabilities?.no===undefined
    || (selected.choice==="yes" && (selected.probabilities?.yes??0)>=0.85);
  const numbered=strong("numbered_move_target",0.9),opening=strong("played_opening",0.9);
  // Numbered historical moves need a nonlocal anchor and weak board/reference
  // veto scores. Unknown scores cannot authorize omission.
  const numberedExtra=numbered && selected.choice==="no" && (board.probabilities?.yes??1)<0.7
    && (local.type==="choice" ? local.probabilities?.yes??1 : 1)<0.85;
  const openingExtra=opening && selected.choice==="no" && board.choice==="no";
  // Three concordant review heads may outweigh a weak board classification,
  // but never an identified selected anchor or an unmeasured/strong local veto.
  const reviewExtra=independentReview && strong("game_review",0.85) && strong("retrospective_review",0.85)
    && selected.choice==="no" && (board.probabilities?.yes??1)<0.7
    && (local.type==="choice" ? local.probabilities?.yes??1 : 1)<0.85;
  const omitSelectedContext=!selectedGuard && (historicalOmission||numberedExtra||openingExtra||reviewExtra);
  const retrospective=answers.retrospective_review as {choice:"yes"|"no";probabilities?:{no?:number}};
  const historicalReview=(answers.game_review as {choice:"yes"|"no"}).choice==="yes" || strong("review_only",0.85);
  const reviewGame=historicalReview && !(selected.choice==="yes" && retrospective.choice==="no"
    && (retrospective.probabilities?.no??0)>=0.85);
  const explicitRecord=strong("game_context",0.75);
  const includeGameRecord=omitSelectedContext || numbered || opening || reviewGame || explicitRecord
    || (answers.game_record as {choice:"yes"|"no"}).choice==="yes";
  return {omitSelectedContext,includeGameRecord,reviewGame};
}

/** KE-REASON-024: question-only intent; callers resolve the move using frozen context. */
export function hasMoveClassificationQuestion(decision:QuestionRoutingDecision):boolean {
  const answer=decision.answers?.move_classification;
  return decision.status==='classified' && answer?.type==='choice' && answer.choice==='yes';
}
/** Transitional alias: this indicates intent, not whether its target is the selected move. */
export const shouldInspectCurrentClassification=hasMoveClassificationQuestion;
