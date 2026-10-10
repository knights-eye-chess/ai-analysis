import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
rmSync('dist',{recursive:true,force:true});
const result=await build({entryPoints:{index:'src/chess-reasoning/answer-pipeline-exports.ts',research:'src/chess-reasoning/research-exports.ts',shared:'src/shared-exports.ts'},bundle:true,format:'esm',platform:'neutral',target:'es2022',packages:'external',splitting:true,outdir:'dist',metafile:true});
const shared=await build({entryPoints:['src/shared-exports.ts'],bundle:true,format:'esm',platform:'neutral',target:'es2022',packages:'external',write:false,metafile:true});
const sharedImports=[...new Set(Object.values(shared.metafile.outputs).flatMap(output=>output.imports.filter(item=>item.external).map(item=>item.path)))];
if(sharedImports.some(name=>name === 'ai' || name.startsWith('@ai-sdk/') || name.startsWith('@knights-eye-chess/move-classifier')))throw Error('Model or classifier runtime leaked into shared helpers: '+sharedImports.join(', '));
writeFileSync('dist/shared-runtime-closure.json',JSON.stringify({runtimeInputs:Object.keys(shared.metafile.inputs).sort(),externalImports:sharedImports},null,2)+'\n');
const declaration=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','tsconfig.json'],{encoding:'utf8'});
if(declaration.status!==0)throw Error(declaration.stdout+declaration.stderr);
function rewrite(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+item.name;if(item.isDirectory())rewrite(p);else if(p.endsWith('.d.ts'))writeFileSync(p,readFileSync(p,'utf8').replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_m,q,s)=>q+s+(s.endsWith('.js')?'':'.js')+q));}}
rewrite('dist/types');
writeFileSync('dist/runtime-closure.json',JSON.stringify({runtimeInputs:Object.keys(result.metafile.inputs).sort(),externalImports:[...new Set(Object.values(result.metafile.outputs).flatMap(o=>o.imports.filter(i=>i.external).map(i=>i.path)))],runtimeBytes:Object.values(result.metafile.outputs).reduce((n,o)=>n+o.bytes,0)},null,2)+'\n');

copyFileSync('test/answer-pipeline.test.mjs','dist/answer-pipeline.test.mjs');

for (const file of readdirSync('test/owner').filter(file => file.endsWith('.test.mjs'))) {
  await build({entryPoints:['test/owner/'+file],bundle:true,format:'esm',platform:'node',target:'es2022',packages:'external',outfile:'dist/owner-tests/'+file});
}
