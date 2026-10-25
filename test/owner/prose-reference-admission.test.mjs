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


test('completed unrestricted MultiPV witnesses accept fewer lines without changing requested scope', () => {
  const fen='7r/p1p1p1kp/2p2rpQ/3q4/3P4/2P5/P1P2PP1/R3K2R b KQ - 5 18';
  const context={kind:'position',nodeId:'two-legal',historyStartFen:fen,historyUci:[],moveUci:'',moveSan:'',fenBefore:fen,fenAfter:fen};
  const roots=['g7g8','g7f7'];
  assert.deepEqual(new Set(new Chess(fen).moves({verbose:true}).map(m=>m.from+m.to)),new Set(roots));
  const witness={version:'fresh-engine-pv-witness/1',acquisition:'same-answer-engine',acquisitionId:1,
    evidenceId:'server-engine-acquisition:two-legal',contextHash:reasoningContextHash(context),phase:'before',fen,
    engineBuild:'test-engine',command:'go depth 18',requestedDepth:18,multiPv:3,rootMoves:[],
    authority:'bounded-engine',licenses:['engine.bounded-continuation'],
    lines:roots.map((rootMove,index)=>({rootMove,pv:[rootMove],depth:18,scoreCp:-200-index,mateInMoves:null,
      scoreProvenance:{kind:'root-search',fen,engineBuild:'test-engine',command:'go depth 18',originatingDepth:18,reportedDepth:18}}))};
  const admitted=admitFreshEnginePvWitnesses(context,[witness]);
  assert.equal(admitted.audit.acceptedLines,2);
  assert.equal(witness.multiPv,3,'requested MultiPV remains provenance, not returned-line count');
  assert.equal(admitFreshEnginePvWitnesses(context,[{...witness,lines:[witness.lines[0]]}]).audit.acceptedLines,1);
  for (const patch of [{lines:[]},{multiPv:1},{rootMoves:roots,lines:[witness.lines[0]]}]) {
    assert.equal(admitFreshEnginePvWitnesses(context,[{...witness,...patch}]).audit.acceptedLines,0);
  }
  for (const change of [line=>{line.depth=17;},line=>{line.scoreCp=null;},line=>{line.pv=['g7g6'];}]) {
    const invalid=structuredClone(witness);change(invalid.lines[1]);
    assert.equal(admitFreshEnginePvWitnesses(context,[invalid]).audit.acceptedLines,0);
  }
  const rendered=simpleProseReferences('[Kg8](move:before:g7g8)',context,[],undefined,undefined,undefined,{freshEnginePvWitnesses:[witness]});
  assert.equal(rendered.referenceGapCounts.unresolvedReferences,0);
  assert.equal(rendered.freshEnginePvAdmission.acceptedLines,2);
});

test('historical prose labels preserve legal recorded castling navigation without granting engine authority',()=>{
  const board=new Chess(),startFen=board.fen();
  const moves=['e4','e5','Nf3','Nc6','Bc4','Nf6','d3','Bc5','a3','a6','h3','h6','Nc3','d6','O-O'].map(san=>{
    const m=board.move(san);return {san:m.san,uci:m.from+m.to+(m.promotion??'')};
  });
  const context={kind:'position',nodeId:'start',historyStartFen:startFen,historyUci:[],moveUci:'',moveSan:'',fenBefore:startFen,fenAfter:startFen};
  const line={startFen,moves};
  const render=(label,target='game:14:e1g1',recorded=line)=>simpleProseReferences(`[${label}](${target})`,context,[],recorded);
  const canonical=render('8. O-O'),prose=render('castled on move 8');
  assert.equal(canonical.coverage.resolved,1);
  assert.equal(prose.coverage.resolved,1);
  const ref=prose.blocks[0].tokens[0].reference;
  assert.equal(ref.label,'castled on move 8');
  assert.equal(ref.kind,'sequence');
  assert.deepEqual(ref.position,canonical.blocks[0].tokens[0].reference.position);
  assert.equal(ref.position.fen,board.fen());
  assert.deepEqual(ref.evidenceIds,[],'recorded navigation is not an engine conclusion');
  assert.equal(ref.position.recordedContext.historyUci.length,13);
  for (const label of ['9. O-O','8. O-O-O','8. d4','8. Nf3','O-O-O','8. Bxf7+','castled (8. Nf3)']) assert.equal(render(label).coverage.resolved,0,label);
  const root=ref.position.recordedContext;
  const hypothetical={id:'evidence:castle',contextHash:reasoningContextHash(context),kind:'probe',source:'Stockfish/explore-continuations',
    licenses:['engine.bounded-continuation'],proofStrength:null,coverage:null,
    replay:{fen:root.fenAfter,movesUci:['e1g1']},
    data:{recordedPosition:{recordHash:'fixture',ply:14,startFen,fen:root.fenAfter,historyUci:moves.slice(0,14).map(m=>m.uci),
      rootContextHash:reasoningContextHash({...root,nodeId:'recorded:fixture:14'})},details:{phase:'after'}}};
  const alternate={startFen,moves:[...moves.slice(0,14),{uci:'d3d4',san:'d4'}]};
  const witnessed=simpleProseReferences('[could have castled](game:14:e1g1)',context,[hypothetical],alternate);
  assert.equal(witnessed.coverage.resolved,1);
  assert.deepEqual(witnessed.blocks[0].tokens[0].reference.evidenceIds,['evidence:castle']);
  const foreign=structuredClone(hypothetical);foreign.data.recordedPosition.rootContextHash='another-occurrence';
  assert.equal(simpleProseReferences('[could have castled](game:14:e1g1)',context,[foreign],alternate).coverage.resolved,0);

  for(const target of ['game:0:e1g1','game:14:e1c1','game:14:d3d4','game:99:e1g1','game:14:e1g1,a8a1']) {
    const rejected=render('castled on move 8',target);
    assert.equal(rejected.coverage.resolved,0,target);
    assert.ok(rejected.gaps.length,target);
  }
  assert.equal(render('castled on move 8','game:14:e1g1',{startFen,moves:moves.slice(0,14)}).coverage.resolved,0,
    'legal but unrecorded castle cannot be promoted to actual play');
});
