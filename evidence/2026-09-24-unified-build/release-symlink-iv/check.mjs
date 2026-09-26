import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {sealArtifact} from '../../../ops/release/release.mjs';
const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'remold-release-directory-iv-')),out=new URL('./result.json',import.meta.url),sha='d'.repeat(40),results=[];
const run=(script,...args)=>{const x=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});return{status:x.status,stdout:x.stdout,stderr:x.stderr};};
try {
 const artifact=join(temp,'artifact');mkdirSync(artifact);mkdirSync(join(artifact,'assets'));writeFileSync(join(artifact,'index.html'),'<main>Independent synthetic artifact</main>');writeFileSync(join(artifact,'version.json'),JSON.stringify({sha}));writeFileSync(join(artifact,'assets/app.js'),'export const release = 17;');
 const pin=sealArtifact(artifact,{sha,baseSha:'e'.repeat(40),schemaSha256:'f'.repeat(64),release:{class:'ui-only',rollbackTarget:'e'.repeat(40)},checks:['independent synthetic fixture']});
 const old=readFileSync(new URL('./before-release.mjs',import.meta.url),'utf8');assert.equal(createHash('sha256').update(old).digest('hex'),'570f4c5f8d7748a39d1c64e8d36330ae922ff4f45fe09dc5d1b04eb32fdd78ad','Pinned predecessor must be unchanged');
 const oldDir=join(temp,'old');mkdirSync(oldDir);writeFileSync(join(oldDir,'release.mjs'),old);symlinkSync(oldDir,join(temp,'old-alias'),'dir');symlinkSync(resolve(root,'ops/release'),join(temp,'candidate-alias'),'dir');
 const oldScript=join(temp,'old-alias/release.mjs'),candidate=join(temp,'candidate-alias/release.mjs');assert.notEqual(candidate,realpathSync(candidate));
 const beforeGood=run(oldScript,'verify',artifact,sha,pin),afterGood=run(candidate,'verify',artifact,sha,pin);assert.equal(beforeGood.status,0);assert.equal(beforeGood.stdout,'');assert.equal(afterGood.status,0);assert.equal(JSON.parse(afterGood.stdout).sha,sha);
 writeFileSync(join(artifact,'assets/app.js'),'export const release = 18;');const beforeBad=run(oldScript,'verify',artifact,sha,pin),afterBad=run(candidate,'verify',artifact,sha,pin);assert.equal(beforeBad.status,0);assert.equal(beforeBad.stdout,'');assert.equal(afterBad.status,1);assert.match(afterBad.stderr,/inventory mismatch/);
 const wrapper=join(temp,'import.mjs');writeFileSync(wrapper,`import {verifyArtifact} from ${JSON.stringify(pathToFileURL(candidate).href)}; if(typeof verifyArtifact!=='function')throw Error('missing export'); console.log('IMPORT_OK');`);const imported=run(wrapper,'verify',artifact,sha,pin);assert.equal(imported.status,0);assert.equal(imported.stdout,'IMPORT_OK\n');assert.equal(imported.stderr,'');
 const evalImport=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(candidate).href)});console.log('EVAL_IMPORT_OK')`],{encoding:'utf8'});assert.equal(evalImport.status,0);assert.equal(evalImport.stdout,'EVAL_IMPORT_OK\n');
 const hash=x=>createHash('sha256').update(x).digest('hex');
 writeFileSync(out,JSON.stringify({verdict:'PASS',oldSha256:hash(old),sourceHashes:Object.fromEntries(['ops/release/release.mjs','ops/release/release.test.mjs'].map(p=>[p,hash(readFileSync(p))])),directorySymlink:true,beforeGood,afterGood,beforeBad,afterBad,normalImport:imported,evalImport:{status:evalImport.status,stdout:evalImport.stdout},providerCalls:0},null,2)+'\n');console.log('PASS directory symlink old-red/new-green, altered bytes refusal, file and eval import without CLI effects');
}finally{rmSync(temp,{recursive:true,force:true});}
