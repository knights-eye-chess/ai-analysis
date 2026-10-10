import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {simpleProseReferences,reasoningContextHash,admitFreshEnginePvWitnesses} from '../../src/chess-reasoning/answer-pipeline-exports.ts';

test('fresh answer witnesses preserve shipped v22 reference geometry and reject foreign engine evidence',()=>{
  const board=new Chess(),fen=board.fen();
  const context={kind:'position',nodeId:'start',historyStartFen:fen,historyUci:[],moveUci:'',moveSan:'',fenBefore:fen,fenAfter:fen};
  const witness={version:'fresh-engine-pv-witness/1',acquisition:'same-answer-engine',acquisitionId:1,
    evidenceId:'server-engine-acquisition:1',contextHash:reasoningContextHash(context),phase:'before',fen,
    engineBuild:'test-engine',command:'go depth 18',requestedDepth:18,multiPv:1,rootMoves:[],
    authority:'bounded-engine',licenses:['engine.bounded-continuation'],
    lines:[{rootMove:'e2e4',pv:['e2e4','e7e5'],depth:18,scoreCp:20,mateInMoves:null,
      scoreProvenance:{kind:'root-search',fen,engineBuild:'test-engine',command:'go depth 18',originatingDepth:18,reportedDepth:18}}]};
  const answer='[e5](move:before:e2e4,e7e5)';
  const rendered=simpleProseReferences(answer,context,[],undefined,undefined,undefined,{freshEnginePvWitnesses:[witness]});
  assert.equal(rendered.freshEnginePvAdmission.acceptedLines,1);
  assert.equal(rendered.blocks[0].tokens[0].reference.position.moves.length,2);
  assert.equal(rendered.blocks[0].tokens[0].reference.engineEvidence[0].evidenceId,witness.evidenceId);
  assert.equal(rendered.referenceGapCounts.unresolvedReferences,0);
  const foreign=structuredClone(witness);foreign.contextHash='foreign';
  assert.equal(admitFreshEnginePvWitnesses(context,[foreign]).audit.acceptedLines,0);
  const rejected=simpleProseReferences(answer,context,[],undefined,undefined,undefined,{freshEnginePvWitnesses:[foreign]});
  assert.equal(rejected.referenceGapCounts.unresolvedReferences,1);
  assert.equal(rejected.blocks[0].tokens[0].reference,undefined);
});
