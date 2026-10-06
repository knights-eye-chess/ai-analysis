import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root=process.cwd(),destination=path.resolve(process.argv[2]||root);
const scan=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8'});
if(scan.status!==0)throw Error(scan.stderr);
const listing=JSON.parse(scan.stdout)[0];
const stage=mkdtempSync(path.join(os.tmpdir(),'knights-eye-pack-'));
for(const {path:relative} of listing.files){const to=path.join(stage,relative);mkdirSync(path.dirname(to),{recursive:true});copyFileSync(path.join(root,relative),to);}
const pkg=JSON.parse(readFileSync(path.join(stage,'package.json'),'utf8'));
for(const [name,value] of Object.entries(pkg.dependencies||{}))if(value.startsWith('file:')){
 const result=spawnSync('tar',['-xOf',path.resolve(root,value.slice(5)),'package/package.json'],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr);
 const dependency=JSON.parse(result.stdout);if(dependency.name!==name)throw Error('Dependency identity mismatch');pkg.dependencies[name]=dependency.version;
}
delete pkg.overrides;
writeFileSync(path.join(stage,'package.json'),JSON.stringify(pkg,null,2)+'\n');
mkdirSync(destination,{recursive:true});
const result=spawnSync('npm',['pack','--ignore-scripts','--pack-destination',destination],{cwd:stage,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
