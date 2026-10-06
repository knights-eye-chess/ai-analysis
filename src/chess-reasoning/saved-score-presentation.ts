/** Stored numeric mate sentinels are bookkeeping, never centipawn evidence. */
export function savedScorePresentation(a: {beforeCp:number|null;afterCp:number|null;lossCp:number|null;mateBefore:number|null;mateAfter:number|null}) {
  const finiteCp=(cp:number|null,mate:number|null)=>mate!==null || cp!==null&&Math.abs(cp)>=100000 ? null : cp;
  const beforeCp=finiteCp(a.beforeCp,a.mateBefore),afterCp=finiteCp(a.afterCp,a.mateAfter);
  return {beforeCp,afterCp,lossCp:a.mateBefore!==null||a.mateAfter!==null||beforeCp===null||afterCp===null||a.lossCp===9999?null:a.lossCp,mateBefore:a.mateBefore,mateAfter:a.mateAfter};
}
