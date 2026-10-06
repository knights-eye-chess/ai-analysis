export type WikibooksTarget = { title: string; relation: 'current' | 'before' | 'continuation' };
export type WikibooksPage = {
  title: string;
  relation: WikibooksTarget['relation'] | 'ancestor';
  matchedTargets?: Array<{ requestedTitle: string; relation: WikibooksTarget['relation']; ancestorPlies: number; transposition: boolean }>;
  requestedTitle?: string;
  ancestorPlies?: number;
  transposition?: boolean;
  positionFen: string;
  revisionId: number;
  revisionTimestamp: string;
  url: string;
  authorHistoryUrl: string;
  attribution: string;
  license: 'CC BY-SA 4.0';
  licenseUrl: string;
  prose: string;
};
export type WikibooksContextResult = {
  status: 'available' | 'outside-scope' | 'unavailable' | 'invalid-context' | 'aborted';
  contextHash: string | null;
  scope?: 'game-review';
  pages: WikibooksPage[];
  /** Local usable-prose catalog title candidates checked during this lookup. */
  localIndexCandidateCount: number;
  /** Recorded-game positions checked against the local catalog before title selection. */
  localIndexPositionCheckCount: number;
  /** Distinct catalog titles selected for possible live revision retrieval. */
  localIndexSelectedTitleCount: number;
  /** Selected titles already present in this answer's transport cache. */
  cacheHitTitleCount: number;
  /** Actual MediaWiki fetch attempts, retained alongside requestCount for clarity. */
  networkRequestCount: number;
  /** Exact titles sent in those fetch attempts, including redirects and continuations. */
  networkRequestedTitles: string[];
  requestCount: number;
  timingMs: number;
  limitations: string[];
};
export type WikibooksPlan = {
  status: 'in-scope' | 'outside-scope' | 'invalid-context';
  rootTitle: string;
  beforeTitle: string | null;
  currentTitle: string | null;
  currentFen: string | null;
};

