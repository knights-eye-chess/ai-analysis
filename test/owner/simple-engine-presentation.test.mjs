import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {projectEnginePresentation} from '../../src/chess-reasoning/simple-engine-presentation.ts';

const pv=['e2e4','d7d5','e4d5','d8d5'];
function fixture() {
 const b=new Chess(),fens=[b.fen()];
 for(const m of pv){b.move({from:m.slice(0,2),to:m.slice(2,4)});fens.push(b.fen());}
 const segments=[0,2].map(startPly=>({fen:fens[startPly],startPly,depth:18,pv:pv.slice(startPly),scoreCp:15,matePly:null,command:'go depth 18',engine:'Stockfish',engineBuild:'18',cacheProvenance:'engine'}));
 const moves=pv.map((uci,i)=>({uci,capture:i>1?{pieceType:'p'}:null,givesCheck:false,captureGeometry:{test:i}}));
 return {evidence:[{id:'e1',source:'Stockfish/compare_moves',data:{searchScope:{fen:fens[0]},lines:[{pv,rawPv:[...pv],depth:18,pvCompletion:{conditional:true,status:'complete',segments}}],continuationMoveFacts:[{rootMove:pv[0],moves}]}}]};
}
test('KE-REASON-016/021: default view removes only deep geometry and exact PV duplicates while preserving complete internal records',()=>{
 const raw=fixture(),copy=structuredClone(raw),v=projectEnginePresentation(raw),d=v.evidence[0].data;
 assert.deepEqual(raw,copy);
 assert.deepEqual(d.continuationMoveFacts[0].moves.map(m=>!!m.captureGeometry),[true,true,false,false]);
 assert.deepEqual(d.continuationMoveFacts[0].moves.map(m=>m.capture),copy.evidence[0].data.continuationMoveFacts[0].moves.map(m=>m.capture));
 assert.equal(d.lines[0].rawPv,undefined);assert.deepEqual(d.lines[0].pv,pv);
 assert.equal(d.modelPresentation.retrieveFullEvidenceId,'e1');
 const segments=d.lines[0].pvCompletion.segments;
 assert.deepEqual(segments.map(s=>s.fenFromLinePvPly),[0,2]);
 for(let i=0;i<segments.length;i++){const {fen,...original}=copy.evidence[0].data.lines[0].pvCompletion.segments[i];const {fenFromLinePvPly,...actual}=segments[i];void fen;void fenFromLinePvPly;assert.deepEqual(actual,original);}
 const full=projectEnginePresentation(raw,true).evidence[0].data;
 assert.deepEqual(full.continuationMoveFacts,copy.evidence[0].data.continuationMoveFacts);
 assert.equal(full.modelPresentation.omittedCaptureGeometry,undefined);
});
test('KE-REASON-021: unequal original PV and mismatched segment FEN remain explicit',()=>{
 const raw=fixture(),line=raw.evidence[0].data.lines[0];
 line.rawPv=pv.slice(0,2);line.pvCompletion.segments[1].fen='unverified';
 const d=projectEnginePresentation(raw).evidence[0].data;
 assert.deepEqual(d.lines[0].rawPv,pv.slice(0,2));
 assert.equal(d.lines[0].pvCompletion.segments[1].fen,'unverified');
 assert.equal(d.lines[0].pvCompletion.segments[1].fenFromLinePvPly,undefined);
});
test('KE-REASON-016: unrelated geometry and unknown record shapes stay intact',()=>{
 const raw={id:'other',data:{captureGeometry:{detail:'preserve'},continuationMoveFacts:[{moves:[1,2,{captureGeometry:{detail:'preserve'}}]}]}};
 assert.deepEqual(projectEnginePresentation(raw),raw);
});

test('KE-REASON-016: recorded-position tools project nested details without losing historical scope',()=>{
 const raw=fixture(),data=raw.evidence[0].data;
 raw.evidence[0].data={recordedPosition:{ply:10,fen:data.searchScope.fen},details:data};
 const v=projectEnginePresentation(raw).evidence[0];
 assert.deepEqual(v.data.recordedPosition,raw.evidence[0].data.recordedPosition);
 assert.equal(v.data.details.lines[0].rawPv,undefined);
 assert.equal(v.data.details.continuationMoveFacts[0].moves[2].captureGeometry,undefined);
 assert.equal(v.data.details.modelPresentation.retrieveFullEvidenceId,'e1');
 assert.deepEqual(projectEnginePresentation(raw,true).evidence[0].data.details.continuationMoveFacts,data.continuationMoveFacts);
});
