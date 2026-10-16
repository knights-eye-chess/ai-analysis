import test from 'node:test';
import assert from 'node:assert/strict';
import {selectBranchHost, DEFAULT_BRANCH_EXPANSION_MODE} from '../../src/chess-reasoning/branch-expansion-policy.ts';
const preparationIds=['initial-search-1','initial-search-12','initial-chain-1-discovery','initial-chain-12-comparison'];
const ordinaryIds=['model-call-1','initial-chain-1','initial-chain-1-retry','initial-chain-1-discovery-extra','prefix-initial-search-1',undefined];
function host(label) { return {descriptors:()=>[],execute:async()=>({label,evidence:[]})}; }
for(const mode of ['off','preparation','tools','both']) {
 test(`branch expansion ${mode} preserves preparation routing for serial and chain IDs`,async()=>{
  const selected=selectBranchHost(host('ordinary'),host('expanded'),mode);
  for(const callId of preparationIds) {
   const result=await selected.execute('analyze_game_position',{callId});
   assert.equal(result.label,['preparation','both'].includes(mode)?'expanded':'ordinary',String(callId));
  }
  for(const callId of ordinaryIds) {
   const result=await selected.execute('analyze_game_position',{callId});
   assert.equal(result.label,['tools','both'].includes(mode)?'expanded':'ordinary',String(callId));
  }
 });
}
test('experimental branch expansion remains off by default',()=>assert.equal(DEFAULT_BRANCH_EXPANSION_MODE,'off'));
