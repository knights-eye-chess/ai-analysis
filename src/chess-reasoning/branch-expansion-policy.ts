import type { BranchExpansionConfig } from './branch-expansion';
import type { InitialSearchPlan } from './initial-search-plan';
import type { ReasoningPositionContext, ReasoningToolSet } from './poc-contracts';

export type BranchExpansionMode = 'off' | 'preparation' | 'tools' | 'both';
// Experimental until real-engine cost and answer qualification are complete.
export const BRANCH_EXPANSION_OPTIONS: BranchExpansionConfig = {maxNodes:8,maxPlies:4,maxLines:2,depthFloor:14,depthMode:'decreasing',maxElapsedMs:20000};
export const DEFAULT_BRANCH_EXPANSION_MODE: BranchExpansionMode = 'off';

/** Add a registered actual-after search without replacing hypothetical eager leads.
 * Selected-context retention is the authority; omitted historical questions must
 * acquire their explicit root through ordinary tools. No natural-language guesses. */
export function withBranchPreparation(plan: InitialSearchPlan, context: ReasoningPositionContext,
  omitSelectedContext: boolean, mode: BranchExpansionMode): InitialSearchPlan {
  if (!(mode === 'both' || mode === 'preparation') || omitSelectedContext || context.kind === 'position' || plan.requests.length) return plan;
  return {...plan, requests:[{tool:'explore_continuations',input:{phase:'after',depth:18,multiPv:3},
    reason:'Bounded actual-after continuation and response discovery; distinct from hypothetical skipped-turn leads.'}]};
}

/** Both hosts keep the same contracts. Only internally generated initial calls
 * select the preparation arm; user/model tool schemas cannot alter this setting. */
export function selectBranchHost(ordinary: ReasoningToolSet, expanded: ReasoningToolSet,
  mode: BranchExpansionMode): ReasoningToolSet {
  return {reservesSearchAtDispatch:true, seedEvidence:records=>{const all=[...records];ordinary.seedEvidence?.(all);expanded.seedEvidence?.(all);}, descriptors:()=>ordinary.descriptors(), execute:async(name,input,signal,execution)=> {
    const initial = typeof input.callId === 'string' && /^initial-(?:search-\d+|chain-\d+-(?:discovery|comparison))$/.test(input.callId);
    const enabled = mode === 'both' || (initial ? mode === 'preparation' : mode === 'tools');
    const selected = enabled ? expanded : ordinary;
    const result = await selected.execute(name,input,signal,execution);
    (enabled ? ordinary : expanded).seedEvidence?.(result.evidence);
    return result;
  }};
}
