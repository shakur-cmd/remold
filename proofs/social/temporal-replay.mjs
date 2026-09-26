// Bounded exact-workflow SERVICE: real Temporal, synthetic database and provider activities.
import { Connection, Client } from '@temporalio/client';
import ts from 'typescript';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';
import {authority} from './h0-authority.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const checkout=JSON.parse(readFileSync(join(here,'evidence/source-checkouts.json'))).postiz;
const sourcePaths={workflow:'apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts',heartbeat:'libraries/nestjs-libraries/src/temporal/temporal.heartbeat.ts',make:'libraries/nestjs-libraries/src/services/make.is.ts',search:'libraries/nestjs-libraries/src/temporal/temporal.search.attribute.ts'};
const sources=Object.fromEntries(Object.entries(sourcePaths).map(([name,path])=>[name,readFileSync(join(checkout.path,path),'utf8')]));
const hash=value=>createHash('sha256').update(value).digest('hex');
const address=process.env.TEMPORAL_ADDRESS??'127.0.0.1:3563';
const connection=await Connection.connect({address}),client=new Client({connection});
try{await connection.workflowService.describeNamespace({namespace:'default'})}catch{await connection.workflowService.registerNamespace({namespace:'default',workflowExecutionRetentionPeriod:{seconds:86400}})}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const mode=process.argv[2]??'baseline';assert.ok(['baseline','patched','permit-baseline','permit-patched'].includes(mode));
const dir=realpathSync(mkdtempSync(join(tmpdir(),`remold-social-${mode}-`)));symlinkSync(join(here,'node_modules'),join(dir,'node_modules'),'dir');writeFileSync(join(dir,'events.jsonl'),'');
let workflow=sources.workflow;
if(mode==='patched'){
 const block=/      if \(\n        heartbeats &&\n        err\.cause\.timeoutType === TimeoutType\.HEARTBEAT &&\n        !err\.cause\.lastHeartbeatDetails\n      \) \{\n        return \{ type: 'retry', message: '' \};\n      \}/;
 assert.match(workflow,block);workflow=workflow.replace(block,'      // No receipt does not prove that an irreversible provider call never ran.');
}
for(const [name,text] of Object.entries({...sources,workflow})){
 const mapped=text.replaceAll("'@gitroom/nestjs-libraries/services/make.is'","'./make.cjs'").replaceAll("'@gitroom/nestjs-libraries/temporal/temporal.search.attribute'","'./search.cjs'");
 writeFileSync(join(dir,`${name}.cjs`),ts.transpileModule(mapped,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
}
const children=[];let logs='';let h0;const permitMode=mode.startsWith('permit-');
function worker(role,queue,workerMode){return new Promise((resolve,reject)=>{const child=fork(join(here,'temporal-worker.mjs'),[role,dir,queue,workerMode],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,HOME:dir,TMPDIR:dir,TEMPORAL_ADDRESS:address}});children.push(child);child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(`Worker exited ${code}`))});child.on('message',m=>{if(m.type==='ready')resolve(child)});});}
const runId=randomUUID(),queue='social-main-'+runId,provider='social-provider-'+runId;
const events=()=>readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
try{
 if(permitMode){h0=await authority();writeFileSync(join(dir,'authority.json'),JSON.stringify(h0.permit),{mode:0o600});}
 await worker('main',queue,'finish');const crashing=await worker('provider',provider,permitMode?mode:'crash');
 const boundary=permitMode?new Promise(resolve=>crashing.on('message',m=>{if(m.type==='before-provider')resolve()})):null;
 const accepted=new Promise(resolve=>crashing.on('message',m=>{if(m.type==='accepted')resolve(Date.now())}));
 const handle=await client.workflow.start('postWorkflowV112',{taskQueue:queue,workflowId:`social-${mode}-${runId}`,args:[{taskQueue:provider,postId:'post-synthetic',organizationId:'org-synthetic',postNow:true}]});
 let acceptedAt=0,killedAt=0;
 if(permitMode){await boundary;await h0.revoke();crashing.send({type:'authority-revoked-continue'});}
 else{acceptedAt=await accepted;await sleep(1500);crashing.kill('SIGKILL');killedAt=Date.now();assert.ok(killedAt-acceptedAt<15000);await worker('provider',provider,'finish');console.log(`${mode}: synthetic receipt accepted, worker killed after ${killedAt-acceptedAt}ms; waiting real3-minute heartbeat timeout.`);}
 let deadline;const result=await Promise.race([handle.result(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Workflow deadline exceeded')),260000)})]).finally(()=>clearTimeout(deadline));
 const history=await handle.fetchHistory();const failures=(history.events??[]).filter(e=>e.activityTaskTimedOutEventAttributes).map(e=>({timeoutType:e.activityTaskTimedOutEventAttributes.failure?.timeoutFailureInfo?.timeoutType,lastHeartbeatDetailsPresent:!!e.activityTaskTimedOutEventAttributes.failure?.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length}));
 const observed=events(),calls=observed.filter(e=>e.type==='providerAccepted').length;
 assert.equal(failures.length,permitMode?0:1);if(!permitMode)assert.equal(failures[0].lastHeartbeatDetailsPresent,false);
 assert.equal(calls,permitMode?(mode==='permit-baseline'?1:0):(mode==='baseline'?2:1));
 if(mode==='permit-patched'){assert.ok(observed.some(e=>e.type==='finalPermitDenied'));assert.ok(!observed.some(e=>e.type==='published'));}
 else if(mode==='patched'){assert.ok(observed.some(e=>e.type==='notification'&&e.unconfirmed));assert.ok(!observed.some(e=>e.type==='published'));}else assert.ok(observed.some(e=>e.type==='published'));
 writeFileSync(join(dir,'history.json'),JSON.stringify(history,null,2)+'\n');
 const evidence={pass:true,runtimeUtilityVersions:Object.fromEntries(['dayjs','lodash'].map(name=>[name,JSON.parse(readFileSync(join(here,'node_modules',name,'package.json'))).version])),fixtureSourceHashes:Object.fromEntries(['temporal-replay.mjs','temporal-worker.mjs','h0-authority.mjs'].map(name=>[name,hash(readFileSync(join(here,name)))])),contractManifest:h0?.manifest,authorityRevokedAfterActivityHandoff:permitMode,serverVersion:address.endsWith(':7233')?'1.28.1':'1.28.0',generatedSourceHashes:Object.fromEntries(Object.keys(sources).map(name=>[name+'.cjs',hash(readFileSync(join(dir,name+'.cjs')))])),importShims:[{from:'@gitroom/nestjs-libraries/services/make.is',to:'./make.cjs',behavior:'exact source transpiled'},{from:'@gitroom/nestjs-libraries/temporal/temporal.search.attribute',to:'./search.cjs',behavior:'exact source transpiled'}],level:'SERVICE real Temporal; exact upstream workflow and heartbeat; synthetic DB/provider',mode,sourceCommit:checkout.commit,sourceHashes:Object.fromEntries(Object.entries(sources).map(([n,s])=>[sourcePaths[n],hash(s)])),sdkVersion:'1.15.0',serverRuntime:address.endsWith(':7233')?{kind:'native',release:'https://github.com/temporalio/temporal/releases/tag/v1.28.1',archiveSha256:'655e3052b9d04cab7bf569a33880bc01996a06f9b2b5d7c475ada9b296389531'}:{kind:'docker',image:'temporalio/temporal:1.4.1',digest:'sha256:9844298258519ebece82b3253f1ee1fc4eb8d87b7abcc264cfb676be342c74a5'},sourceChange:mode==='patched'?'remove no-heartbeat timeout retry branch only':'none beyond TS compilation/import alias resolution',providerActivityHook:mode==='permit-patched'?'experimental fixture wraps synthetic provider with real frozen H0 permit+consume; not yet integrated into Postiz actual provider activity':'none',workerKilledAfterAcceptanceMs:killedAt-acceptedAt,providerAcceptances:calls,failures,events:observed,workflowResult:result??null,actualSocialProviderCalls:0,fullPostizDeployment:false,independentlyVerified:false,scratch:dir};
 writeFileSync(join(here,`evidence/temporal-${mode}${address.endsWith(':7233')?'-exact':''}.json`),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({mode,pass:true,providerAcceptances:calls}));
}catch(error){writeFileSync(join(here,`evidence/temporal-${mode}-failure.json`),JSON.stringify({mode,error:String(error),scratch:dir,events:events()},null,2)+'\n');throw error;}
finally{h0?.stop();for(const child of children)if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');writeFileSync(join(dir,'worker.log'),logs);await connection.close();}
