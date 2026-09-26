import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import net from 'node:net';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const label=process.argv[2]??`builder-${Date.now()}`;assert.match(label,/^[a-zA-Z0-9_-]+$/);
const out=join(here,'evidence/restore',label);mkdirSync(out,{recursive:true});writeFileSync(join(out,'started.json'),JSON.stringify({at:new Date().toISOString(),provider:'DB-backed synthetic stub only'}),{flag:'wx'});
const privateDir=join(here,'.private/restore',label);mkdirSync(privateDir,{recursive:true,mode:0o700});
const hash=b=>createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(readFileSync(join(here,'evidence/restore/baseline-manifest.json'),'utf8'));
const rootEnv=()=>existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null,rootBefore=rootEnv();
function unchanged(){for(const [file,digest] of Object.entries(baseline))assert.equal(hash(readFileSync(join(here,file))),digest,file);assert.equal(rootEnv(),rootBefore);}
unchanged();
const cli=join(root,'node_modules/convex/bin/main.js');assert.equal(JSON.parse(readFileSync(join(root,'node_modules/convex/package.json'))).version,'1.46.0');
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const free=port=>new Promise((ok,no)=>{const s=net.createServer();s.once('error',no);s.listen(port,'127.0.0.1',()=>s.close(ok));});
const projects=[];
function project(name,port){
 const cwd=mkdtempSync(join(privateDir,name+'-'));cpSync(join(here,'convex'),join(cwd,'convex'),{recursive:true});cpSync(join(here,'restoreFixture.ts'),join(cwd,'convex/restoreFixture.ts'));
 for(const f of ['package.json','tsconfig.json','convex.json'])cpSync(join(here,f),join(cwd,f));symlinkSync(join(root,'node_modules'),join(cwd,'node_modules'),'dir');
 const p={name,cwd,port,log:'',child:null,client:new ConvexHttpClient(`http://127.0.0.1:${port}`,{logger:false})};projects.push(p);return p;
}
async function start(p){await free(p.port);await free(p.port+1);p.child=spawn(process.execPath,[cli,'dev','--local-cloud-port',String(p.port),'--local-site-port',String(p.port+1),'--typecheck','enable','--tail-logs','disable'],{cwd:p.cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
 for(const stream of [p.child.stdout,p.child.stderr])stream.on('data',b=>p.log+=b);
 const until=Date.now()+180000;while(!p.log.includes('Convex functions ready')){if(p.child.exitCode!==null||Date.now()>until)throw Error('BACKEND_NOT_READY_'+p.name);await sleep(100);}
 assert.match(readFileSync(join(p.cwd,'.env.local'),'utf8'),new RegExp(`^CONVEX_URL=http://127\\.0\\.0\\.1:${p.port}$`,'m'));
}
async function stop(p,signal='SIGTERM'){if(!p.child)return;const child=p.child;p.child=null;try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}
 for(let i=0;i<100;i++){try{await free(p.port);await free(p.port+1);return;}catch{if(i===99)throw Error('PORT_STILL_RUNNING');await sleep(100);}}
}
function command(p,args){return execFileSync(process.execPath,[cli,...args],{cwd:p.cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
const internal=(p,name,args)=>{const output=command(p,['run',name,JSON.stringify(args)]);return output.trim()?JSON.parse(output):null;};
const mutation=(p,name,args)=>p.client.mutation(makeFunctionReference(name),args);
const query=(p,name,args)=>p.client.query(makeFunctionReference(name),args);
async function taskAt(p,token,id,status){for(let i=0;i<100;i++){const t=await query(p,'runner:task',{token,id});if(t.status===status)return t;await sleep(100);}throw Error('TASK_NOT_'+status);}
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):Array.isArray(v)&&v[0]?._id?[...v].sort((a,b)=>a._id.localeCompare(b._id)):v);
const digest=value=>hash(stable(value));
const counts=s=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v.length]));
function decrypt(encrypted,key){if(!key)throw Error('RESTORE_KEY_MISSING');const e=JSON.parse(encrypted),d=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(e.iv,'hex'));d.setAuthTag(Buffer.from(e.tag,'hex'));return Buffer.concat([d.update(Buffer.from(e.bytes,'base64')),d.final()]).toString();}
const results=[],commands=[];
try{
 const source=project('source',3570),target=project('target',3572);await start(source);
 const f=internal(source,'harness:seed',{run:randomUUID(),tokens:Array.from({length:10},randomUUID)}),token=f.A.sessions.owner;
 await mutation(source,'harness:grant',{token,target:f.A.actors.child,capability:'model.call',scope:{kind:'model',maxUnitsPerRun:2,maxSteps:1},mode:'direct',delegate:false,expires:Date.now()+600000});
 const common={token,assignee:f.A.actors.child,binding:f.A.binding,dependsOn:[],maxAttempts:1};
 const complete=await mutation(source,'runner:create',{...common,title:'Completed before backup'});await mutation(source,'runner:start',{token,id:complete});await taskAt(source,token,complete,'done');
 const lost=await mutation(source,'runner:create',{...common,title:'Accepted effect with lost response',fault:'loseResponse'});await mutation(source,'runner:start',{token,id:lost});const lostTask=await taskAt(source,token,lost,'unknown');
 const unresolved=await mutation(source,'runner:create',{...common,title:'Consumed request without provider receipt'});
 const op=await mutation(source,'harness:propose',{token:f.A.sessions.child,logical:`${unresolved}:1:1`,binding:f.A.binding,capability:'model.call',payload:{content:'Synthetic unresolved work',audience:[],audienceVersion:1,destination:'A',schedule:0,amountMinor:0,currency:'USD',workflowVersion:1},reservationUnits:1,maxSteps:1});
 const claim=await mutation(source,'harness:claim',{token:f.A.sessions.child,id:op,worker:'restore-fixture'}),permit=await mutation(source,'harness:permit',{token:f.A.adapter,id:op,...claim,worker:'restore-fixture'});
 const{expires,maxUnits,maxRecipients,...consume}=permit;await mutation(source,'harness:consume',{token:f.A.adapter,...consume});await mutation(source,'harness:unknown',{token:f.A.adapter,id:op,...claim});internal(source,'restoreFixture:unresolvedTask',{id:unresolved,operation:op});
 const before=internal(source,'restoreFixture:snapshot',{});assert.equal(before.stubEffects.length,2);assert.equal(before.operations.filter(x=>x.state==='outcomeUnknown').length,2);
 const plaintext=JSON.stringify({task:complete,result:before.tasks.find(t=>t._id===complete).artifact,note:'Synthetic result file preserved through storage export'}),key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 const encrypted=JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),bytes:bytes.toString('base64')});
 const file=internal(source,'restoreFixture:store',{ciphertext:encrypted});
 const bundle={version:1,file,key:key.toString('hex'),plaintextSha256:hash(plaintext),ciphertextSha256:hash(encrypted),tasks:{complete,lost,unresolved},fixture:f};
 writeFileSync(join(privateDir,'bundle.json'),JSON.stringify(bundle),{mode:0o600});
 const dataOnly=join(privateDir,'data-only.zip'),full=join(privateDir,'full.zip');
 commands.push({command:'export --path data-only.zip',result:command(source,['export','--path',dataOnly]).trim()});
 commands.push({command:'export --include-file-storage --path full.zip',result:command(source,['export','--include-file-storage','--path',full]).trim()});
 // Crash after accepted effect and stable unknown snapshot; no action is in flight at this export boundary.
 await stop(source,'SIGKILL');await start(target);
 const empty=internal(target,'restoreFixture:snapshot',{});assert.equal(Object.values(empty).flat().length,0);
 await assert.rejects(query(target,'runner:task',{token,id:lost}),/invalid session/);
 writeFileSync(join(out,'empty-target-baseline.json'),JSON.stringify({sourceTaskCount:before.tasks.length,targetTaskCount:empty.tasks.length,sourceEffects:before.stubEffects.length,targetEffects:empty.stubEffects.length,lookup:'refused invalid session before import'},null,2));
 results.push({name:'Real separate empty deployment baseline has no task, session or receipt before import',pass:true});
 commands.push({command:'import data-only.zip into empty disposable target',result:command(target,['import',dataOnly,'--yes']).trim()});
 assert.equal(digest(internal(target,'restoreFixture:snapshot',{})),digest(before));
 let missingFile=false;try{internal(target,'restoreFixture:file',{id:file});}catch(e){missingFile=String(e.stderr??e).includes('RESTORED_FILE_MISSING');}assert.equal(missingFile,true);
 assert.throws(()=>decrypt(encrypted,null),/RESTORE_KEY_MISSING/);
 writeFileSync(join(out,'incomplete-restore-red.json'),JSON.stringify({dataTablesEqual:true,storageOmitted:'RESTORED_FILE_MISSING',keyOmitted:'RESTORE_KEY_MISSING',fullRestoreAccepted:false},null,2));
 commands.push({command:'import full.zip --replace into same disposable target',result:command(target,['import',full,'--replace','--yes']).trim()});
 const restored=internal(target,'restoreFixture:snapshot',{});assert.equal(digest(restored),digest(before));
 const restoredBundle=JSON.parse(readFileSync(join(privateDir,'bundle.json'),'utf8'));
 const restoredEncrypted=internal(target,'restoreFixture:file',{id:restoredBundle.file});assert.equal(hash(restoredEncrypted),restoredBundle.ciphertextSha256);assert.equal(hash(decrypt(restoredEncrypted,restoredBundle.key)),restoredBundle.plaintextSha256);
 const keyless={...restoredBundle};delete keyless.key;writeFileSync(join(privateDir,'bundle-without-key.json'),JSON.stringify(keyless),{mode:0o600});
 assert.throws(()=>decrypt(restoredEncrypted,JSON.parse(readFileSync(join(privateDir,'bundle-without-key.json'),'utf8')).key),/RESTORE_KEY_MISSING/);
 results.push({name:'Table-only restore and missing key refused; full archive/key restores exact tables, file bytes and completed result',pass:true,tableDigest:digest(before),counts:counts(before),filePlaintextSha256:hash(plaintext),fileCiphertextSha256:hash(encrypted),archiveSha256:hash(readFileSync(full)),bundleSha256:hash(readFileSync(join(privateDir,'bundle.json')))});
 await mutation(target,'runner:recover',{token,id:lost});const recovered=await taskAt(target,token,lost,'done');assert.equal(recovered.operation,lostTask.operation);assert.equal(recovered.attempts,1);assert.equal(recovered.artifact,before.stubEffects.find(e=>e.operation===lostTask.operation).artifact);
 for(let i=0;i<3;i++)await mutation(target,'runner:recover',{token,id:lost});
 await mutation(target,'runner:recover',{token,id:unresolved});await sleep(300);
 const after=internal(target,'restoreFixture:snapshot',{}),unknown=after.tasks.find(t=>t._id===unresolved),unknownOp=after.operations.find(o=>o._id===op);
 assert.equal(unknown.status,'unknown');assert.equal(unknown.attempts,1);assert.equal(unknown.artifact,undefined);assert.equal(unknownOp.state,'outcomeUnknown');assert.equal(unknownOp.reserved,1);assert.notEqual(unknownOp.released,true);
 assert.deepEqual(after.stubEffects,before.stubEffects);assert.equal(after.operations.find(o=>o._id===lostTask.operation).receipts.length,1);assert.equal(after.orgs.find(o=>o._id===f.A.org).spent-before.orgs.find(o=>o._id===f.A.org).spent,1);
 for(const event of before.events)assert.deepEqual(after.events.find(e=>e._id===event._id),event);
 assert.deepEqual(after.tasks.find(t=>t._id===complete),before.tasks.find(t=>t._id===complete));
 await assert.rejects(mutation(target,'runner:start',{token,id:lost}),/task not startable/);
 results.push({name:'Restore reconciliation uses same logical task/operation and retained receipt with no repeat fake effect; receipt-less operation remains unknown with reservation',pass:true,beforeEffects:before.stubEffects.length,afterEffects:after.stubEffects.length,recoveredAttempts:recovered.attempts,recoveredReceiptCount:1,unknownState:unknownOp.state,unknownReserved:unknownOp.reserved,historyBefore:before.events.length,historyAfter:after.events.length});
 unchanged();writeFileSync(join(out,'result.json'),JSON.stringify({pass:true,level:'SERVICE actual local Convex export/import/storage; SIM sessions,key,file,DB-backed provider receipt',results,commands,sourceKilled:'SIGKILL after stable unknown snapshot/export',distinctScratchDeployments:true,providerCalls:0,paidModelCalls:0,baselineFilesUnchanged:true,privateArchivePath:privateDir,limitations:['No independently durable remote provider receipt','No reconciliation of effects accepted after backup snapshot','No upgrade pin rehearsal','No hosted or OS isolation proof','P1 remains open']},null,2)+'\n');console.log('PASS '+results.length+' restore groups; exact table/file round trip, same operation recovery, unknown reservation retained');
}catch(error){writeFileSync(join(privateDir,'failure.log'),String(error.stack??error),{mode:0o600});const safe=String(error.message).startsWith('Command failed')?'CLI_FAILED; details retained privately':String(error.message).slice(0,1000);writeFileSync(join(out,'failure.json'),JSON.stringify({error:safe},null,2));console.error(safe);process.exitCode=1;}
finally{for(const p of projects){await stop(p);writeFileSync(join(out,p.name+'-backend.log'),p.log);}unchanged();}
