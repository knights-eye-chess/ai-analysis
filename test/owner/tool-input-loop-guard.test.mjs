import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolInputLoopGuard} from '../../src/chess-reasoning/tool-input-loop-guard.ts';
test('KE-REASON-026: Nc8 repeated final comparison is blocked before dispatch; corrected request stays eligible',()=>{
 const guard=createToolInputLoopGuard(); let validations=0;
 const input={phase:'after',movesUci:['h2h3','e8e4','f1e1','f8e8','a2a4','c8b6','a4a5','b6c4'],inspectSquares:['c4','e4','d3','f5'],inspectPlies:[6,8],analyzeFinal:false,compareFinalMovesUci:['d3c4'],minimumPvPlies:10,depth:18};
 assert.throws(()=>guard.validate('test_line',input,()=>validations++),/requires analyzeFinal=true/);
 for(let n=0;n<3;n++)assert.throws(()=>guard.validate('test_line',{...input},()=>validations++),e=>e.code==='repeated-invalid-tool-input'&&e.repeatedInvalidInput===true);
 assert.equal(validations,1); assert.equal(guard.repeatedFailures,3);
 guard.validate('test_line',{...input,analyzeFinal:true},()=>validations++);
 guard.validate('test_line',{phase:'after',movesUci:input.movesUci,analyzeFinal:false},()=>validations++);
 assert.equal(validations,3);
});
test('KE-REASON-026: canonical keys ignore property order but preserve array order, names and episode boundaries',()=>{
 const guard=createToolInputLoopGuard(); const invalid=()=>{throw Object.assign(new Error('array of 1..6 items'),{code:'invalid-tool-array',field:'compareFinalMovesUci',expected:'array of 1..6 items'});};
 assert.throws(()=>guard.validate('test_line',{analyzeFinal:false,compareFinalMovesUci:[]},invalid));
 assert.throws(()=>guard.validate('test_line',{compareFinalMovesUci:[],analyzeFinal:false},invalid),e=>e.code==='repeated-invalid-tool-input');
 assert.throws(()=>createToolInputLoopGuard().validate('test_line',{compareFinalMovesUci:[],analyzeFinal:false},invalid),e=>e.code==='invalid-tool-array');
 assert.throws(()=>guard.validate('test_game_line',{compareFinalMovesUci:[],analyzeFinal:false},invalid),e=>e.code==='invalid-tool-array');
});
test('KE-REASON-026: unstructured and transient failures are never remembered',()=>{
 const guard=createToolInputLoopGuard(); let attempts=0;
 for(let n=0;n<2;n++)assert.throws(()=>guard.validate('analyze_position',{},()=>{attempts++;throw Error('network failed');}),/network failed/);
 assert.equal(attempts,2);assert.equal(guard.repeatedFailures,0);
});
