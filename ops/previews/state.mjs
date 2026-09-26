import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync,readdirSync,existsSync,realpathSync,fsyncSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {candidateHeads,scope,assertPreviewConfig} from './policy.mjs';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function load(directory) {
 const dir=realpathSync(directory), receipt=JSON.parse(readFileSync(join(dir,'receipt.json')));
 const planBytes=readFileSync(join(dir,'plan.json')),configBytes=readFileSync(join(dir,'wrangler.json'));
 assert.equal(hash(planBytes),receipt.planSha256);assert.equal(hash(configBytes),receipt.configSha256);
 const plan=JSON.parse(planBytes);assert.deepEqual(plan,receipt.plan);assert.equal(plan.sha,candidateHeads[plan.pr]);
 const config=JSON.parse(configBytes);assertPreviewConfig(config);
 const assetPath=existsSync(config.assets.directory)?realpathSync(config.assets.directory):join(realpathSync(dirname(config.assets.directory)),basename(config.assets.directory));
 assert.equal(assetPath,join(dir,'artifact'),'Configured upload directory differs from verified artifact');
 const git=(...args)=>execFileSync('git',args,{cwd:receipt.checkout,encoding:'utf8'}).trim();
 assert.equal(git('rev-parse','HEAD'),plan.sha);assert.equal(git('status','--porcelain','--untracked-files=all'),'');
 assert.equal(git('diff','--name-only',scope.sha,plan.sha),`docs/unified-launch/preview-rehearsal-${plan.pr===3?'a':'b'}.html`);
 assert(!readdirSync(receipt.checkout).some(n=>n.startsWith('.env')&&n!=='.env.example'));
 return {dir,receipt,plan};
}
export function save(dir,receipt) {
 const path=join(dir,'receipt.json'),tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 for(const file of [tmp,join(dir,'plan.json'),join(dir,'wrangler.json')]){const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
 renameSync(tmp,path);const parent=openSync(dir,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
}
export async function locked(dir,fn) {
 const path=join(dir,'operation.lock');const fd=openSync(path,'wx');
 try{return await fn();}finally{closeSync(fd);unlinkSync(path);}
}

export function verifyCI(plan) {
 const pr=JSON.parse(execFileSync('gh',['pr','view',String(plan.pr),'--json','state,headRefOid,baseRefName'],{encoding:'utf8'}));
 assert.equal(pr.state,'OPEN','Preview creation requires an open PR');
 assert.equal(pr.headRefOid,plan.sha,'Current PR head differs from exact candidate');
 assert.equal(pr.baseRefName,'i2/preview-base-b9345f8','Current PR base differs from rehearsal base');
 const run=plan.pr===3?36085477177:36085479573;
 const ci=JSON.parse(execFileSync('gh',['run','view',String(run),'--json','headSha,conclusion,status,url,event,workflowName'],{encoding:'utf8'}));
 assert.equal(ci.headSha,plan.sha);assert.equal(ci.status,'completed');assert.equal(ci.conclusion,'success');return ci;
}

export function isMain(meta) {return !!process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(meta));}
