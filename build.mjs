import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,copyFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const result=await build({entryPoints:['src/chess-reasoning/answer-pipeline-exports.ts'],bundle:true,format:'esm',platform:'neutral',target:'es2022',packages:'external',outfile:'dist/index.js',metafile:true});
const declaration=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','tsconfig.json'],{encoding:'utf8'});
if(declaration.status!==0)throw Error(declaration.stdout+declaration.stderr);
function rewrite(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+item.name;if(item.isDirectory())rewrite(p);else if(p.endsWith('.d.ts'))writeFileSync(p,readFileSync(p,'utf8').replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_m,q,s)=>q+s+(s.endsWith('.js')?'':'.js')+q));}}
rewrite('dist/types');
writeFileSync('dist/runtime-closure.json',JSON.stringify({runtimeInputs:Object.keys(result.metafile.inputs).sort(),externalImports:[...new Set(Object.values(result.metafile.outputs).flatMap(o=>o.imports.filter(i=>i.external).map(i=>i.path)))],runtimeBytes:Object.values(result.metafile.outputs).reduce((n,o)=>n+o.bytes,0)},null,2)+'\n');

copyFileSync('test/answer-pipeline.test.mjs','dist/answer-pipeline.test.mjs');
