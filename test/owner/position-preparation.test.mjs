import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {planInitialSearches} from '../../src/chess-reasoning/initial-search-plan.ts';
const context={kind:'position',nodeId:'root',historyStartFen:'rnbq1rk1/p1p1bpp1/1p3n1p/3p4/3P3B/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 9',historyUci:[],moveUci:'',moveSan:''};
context.fenBefore=context.fenAfter=context.historyStartFen;
const input={context,question:'Assess the current position: what are the main strengths, weaknesses and plans for both sides?',answerScope:'position_analysis',omitSelectedContext:false};
test('KE-REASON-021: prepare same actual position tool before first answering call',()=>{
 const plan=planInitialSearches(input);assert.equal(plan.requests.length,1);assert.equal(plan.requests[0].tool,'explore_continuations');
 assert.deepEqual(plan.requests[0].input,{phase:'before',depth:18,multiPv:3,minimumPvPlies:24});
});
test('retrospective, omitted, general, terminal and explicit ablation do not search an unrelated board',()=>{
 for(const change of [{omitSelectedContext:true},{reviewGame:true},{answerScope:'general'},{positionPreparation:false}])assert.equal(planInitialSearches({...input,...change}).requests.length,0);
 const terminal='7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';assert.ok(new Chess(terminal).isGameOver());
 assert.equal(planInitialSearches({...input,context:{...context,fenBefore:terminal,fenAfter:terminal}}).requests.length,0);
});
test('explicit current-node comparison takes precedence over broad preparation',()=>{
 const p=planInitialSearches({...input,question:'Compare Bd3 and Be2 instead.'});assert.equal(p.requests.length,1);assert.equal(p.requests[0].tool,'compare_moves');
});
test('retained selected-move context assessment searches the after position',()=>{
 const c={...context,kind:'move',moveUci:'e6d5',moveSan:'exd5'};assert.equal(planInitialSearches({...input,context:c}).requests[0].input.phase,'after');
});
