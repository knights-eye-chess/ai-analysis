import type { WikibooksPage } from './opening-source-contracts';
import { EVIDENCE_SHARING_VERSION, expandSharedEvidence } from './lossless-evidence-sharing';
export type OpeningSourceCredit = { title: string; revisionId: number };
export const OPENING_SOURCE_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
export function openingSourceLinks(source: OpeningSourceCredit) {
 const title=encodeURIComponent(source.title.replaceAll(' ','_'));
 return {revision:`https://en.wikibooks.org/w/index.php?title=${title}&oldid=${source.revisionId}`,
  history:`https://en.wikibooks.org/w/index.php?title=${title}&action=history`};
}
/** Persist only bounded attribution metadata, never fetched prose or model data. */
export function parseOpeningSourceCredits(value: unknown): OpeningSourceCredit[] {
 if(!Array.isArray(value)||value.length>512)throw Error('Invalid opening sources.');
 const result:OpeningSourceCredit[]=[],seen=new Set<string>();
 for(const item of value) {
  if(!item||typeof item!=='object'||typeof item.title!=='string'||!item.title.startsWith('Chess Opening Theory/')
   ||item.title.length>2000||/[\u0000-\u001f\u007f]/.test(item.title)||!Number.isSafeInteger(item.revisionId)||item.revisionId<=0)throw Error('Invalid opening source.');
  const key=item.title+'@'+item.revisionId;
  if(!seen.has(key)){seen.add(key);result.push({title:item.title,revisionId:item.revisionId});}
 }
 return result;
}
const key=(page:OpeningSourceCredit)=>page.title+'@'+page.revisionId;
/** Match actual prompt packets against accepted fetched prose. Never credit a
 * lookup merely because it completed: tools may run on the last allowed call. */
export function openingSourcesInMessages(messages:unknown,known:ReadonlyMap<string,WikibooksPage>):OpeningSourceCredit[] {
 const found=new Map<string,OpeningSourceCredit>();
 function visit(value:unknown,depth:number) {
  if(depth>30||value==null)return;
  if(typeof value==='string') {
   if(!/^[\s]*[\[{]/.test(value))return;
   try {visit(JSON.parse(value),depth+1);} catch { /* Ordinary prose. */ }
   return;
  }
  if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
  if(typeof value!=='object')return;
  const record=value as Record<string,unknown>;
  if(record.encoding===EVIDENCE_SHARING_VERSION) {
   // Each self-contained packet owns its dictionary. An invalid packet must not
   // leak credits from definitions that were never delivered as content.
   try { visit(expandSharedEvidence(record),depth+1); } catch { /* Invalid shared packet. */ }
   return;
  }
  if(record.authority==='untrusted-opening-commentary'&&Array.isArray(record.pages))for(const page of record.pages) {
   const original=page&&known.get(key(page));
   if(original&&typeof page.prose==='string'&&page.prose.trim()&&page.prose===original.prose) {
    try {const [credit]=parseOpeningSourceCredits([original]);found.set(key(credit),credit);} catch { /* Never persist malformed source metadata. */ }
   }
  }
  for(const item of Object.values(record))visit(item,depth+1);
 }
 visit(messages,0);return [...found.values()];
}
export const openingSourceKey=key;
