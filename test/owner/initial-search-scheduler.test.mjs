import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleInitialSearches} from '../../src/chess-reasoning/initial-search-scheduler.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const base=()=>({requests:[0,1,2,3,4],signal:new AbortController().signal,shouldDefer:()=>false,comparison:()=>undefined});
test('four lanes bound dispatch and return logical order despite reversed completion',async()=>{
 const gates=Array.from({length:5},deferred),started=[];let active=0,max=0;
 const running=scheduleInitialSearches({...base(),execute:async request=>{started.push(request);max=Math.max(max,++active);await gates[request].promise;active--;return request;}});
 await tick();assert.deepEqual(started,[0,1,2,3]);gates[3].resolve();await tick();assert.deepEqual(started,[0,1,2,3,4]);
 gates[4].resolve();gates[2].resolve();gates[1].resolve();gates[0].resolve();
 const result=await running;assert.equal(max,4);assert.deepEqual(result.items.map(x=>x.outcome.value),[0,1,2,3,4]);
 assert.deepEqual(result.items.map(x=>x.callId),[1,2,3,4,5].map(i=>`initial-chain-${i}-discovery`));
});
test('comparison follows its own discovery immediately and retains stable dependency identity',async()=>{
 const gate=deferred(),seen=[];
 const running=scheduleInitialSearches({...base(),requests:[0,1],execute:async request=>{seen.push(request);if(request===0)await gate.promise;return request;},comparison:request=>request===1?11:undefined});
 await tick();assert.deepEqual(seen,[0,1,11]);gate.resolve();const {items}=await running;
 assert.deepEqual(items.map(x=>x.request),[0,1,11]);assert.equal(items[2].discoveryCallId,items[1].callId);assert.equal(items[2].callId,'initial-chain-2-comparison');
});
test('ordinary failure is retained once without comparison, retry or sibling cancellation',async()=>{
 const seen=[],failure=Error('fixture');const {items}=await scheduleInitialSearches({...base(),execute:async request=>{seen.push(request);if(request===1)throw failure;return request;}});
 assert.equal(items[1].outcome.error,failure);assert.deepEqual(seen,[0,1,2,3,4]);assert.equal(items.filter(x=>'value'in x.outcome).length,4);
});
test('abort stops queued chains and drains every active request including delayed cleanup',async()=>{
 const controller=new AbortController(),cleanup=deferred(),reason=Error('cancelled');let active=0,finished=false;
 const running=scheduleInitialSearches({...base(),signal:controller.signal,execute:async()=>{active++;await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));await cleanup.promise;active--;return 1;}}).finally(()=>{finished=true;});
 const rejected=assert.rejects(running,error=>error===reason);await tick();assert.equal(active,4);controller.abort(reason);await tick();assert.equal(finished,false);cleanup.resolve();await rejected;assert.equal(active,0);
});
test('soft deadline keeps completed work and counts unstarted discoveries and comparisons',async()=>{
 let stop=false;const gate=deferred(),seen=[];
 const running=scheduleInitialSearches({...base(),requests:[0,1,2,3,4,5],shouldDefer:()=>stop,execute:async request=>{seen.push(request);await gate.promise;return request;},comparison:request=>request===0?10:undefined});
 await tick();stop=true;gate.resolve();const result=await running;
 assert.deepEqual(seen,[0,1,2,3]);assert.equal(result.deferred,3);assert.equal(result.items.length,4);
});
test('requests are frozen at dispatch and separate answer schedulers share no state',async()=>{
 const requests=[{id:1}],gate=deferred();
 const one=scheduleInitialSearches({...base(),requests,execute:async request=>{await gate.promise;return request.id;}});
 requests[0].id=99;
 const two=await scheduleInitialSearches({...base(),requests:[{id:2}],execute:async request=>request.id});gate.resolve();
 assert.equal((await one).items[0].outcome.value,1);assert.equal(two.items[0].outcome.value,2);
});
