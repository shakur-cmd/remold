import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import net from 'node:net';
import {ConvexHttpClient} from 'convex/browser';
import {anyApi} from 'convex/server';
import {directory} from '../runtime.mjs';
import {upperSubmissionId,readSubmissionPage,readEmailSuppression} from './native.mjs';
import {exerciseOutage} from './outage.mjs';
const withOutage=process.argv.includes('--callback-outage');
const label=process.argv[2]??'root-'+Date.now();assert.match(label,/^[a-zA-Z0-9_-]+$/);
const output=directory+'capture/evidence/runs/'+label+'/',scratch=directory+'private/capture-'+label,privateHome=join(scratch,'home');
assert.ok(!existsSync(scratch),'Use a new run label; never reset retained state');mkdirSync(output,{recursive:true});mkdirSync(scratch,{recursive:true,mode:0o700});mkdirSync(privateHome,{mode:0o700});
const version='precompiled-2026-09-21-0cf49cb',cached=join(homedir(),'.cache/convex/binaries',version,'convex-local-backend');assert.ok(existsSync(cached));
const binaryDir=join(privateHome,'.cache/convex/binaries',version);mkdirSync(binaryDir,{recursive:true});cpSync(cached,join(binaryDir,'convex-local-backend'));
cpSync(directory+'capture/local',join(scratch,'app'),{recursive:true});symlinkSync(resolve(directory,'../../node_modules'),join(scratch,'app/node_modules'),'dir');
const cli=resolve(directory,'../../node_modules/convex/bin/main.js');assert.equal(JSON.parse(readFileSync(resolve(directory,'../../node_modules/convex/package.json'))).version,'1.46.0');
const env={PATH:process.env.PATH,HOME:privateHome,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const free=port=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve));});
const wait=ms=>new Promise(r=>setTimeout(r,ms));let child,logs='',starts=0;const lifecycle=[],results=[];
async function start(){await free(3620);await free(3621);let current='';child=spawn(process.execPath,[cli,'dev','--local-cloud-port','3620','--local-site-port','3621','--local-backend-version',version,'--typecheck','disable','--tail-logs','disable'],{cwd:join(scratch,'app'),env,detached:true,stdio:['ignore','pipe','pipe']});lifecycle.push({start:++starts,pid:child.pid,at:new Date().toISOString()});for(const s of [child.stdout,child.stderr])s.on('data',b=>{current+=b;logs+=b;});const deadline=Date.now()+180000;while(!current.includes('Convex functions ready')){if(child.exitCode!==null||child.signalCode!==null||Date.now()>deadline)throw Error('LOCAL_BACKEND_NOT_READY');await wait(100);}assert.match(readFileSync(join(scratch,'app/.env.local'),'utf8'),/^CONVEX_URL=http:\/\/127\.0\.0\.1:3620$/m);}
async function stop(signal='SIGTERM'){if(!child)return;const pid=child.pid;child=null;try{process.kill(-pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}for(let n=0;n<100;n++){try{await free(3620);await free(3621);break;}catch{if(n===99)throw Error('LOCAL_BACKEND_NOT_STOPPED');await wait(100);}}lifecycle.at(-1).stopSignal=signal;}
const client=new ConvexHttpClient('http://127.0.0.1:3620',{logger:false}),keys={a:randomBytes(32).toString('hex'),b:randomBytes(32).toString('hex')},bindings={};
const authPath=join(scratch,'auth.json');writeFileSync(authPath,JSON.stringify({keys,bindings}),{mode:0o600,flag:'wx'});
const call=(name,args)=>client.mutation(anyApi.importer[name],args),snap=t=>client.query(anyApi.importer.snapshot,{instance:bindings[t],key:keys[t]});
try{
 await start();
 for(const t of ['a','b']){bindings[t]=await call('seed',{tenant:t,key:keys[t],formId:1});writeFileSync(authPath,JSON.stringify({keys,bindings}),{mode:0o600});}
 await assert.rejects(client.query(anyApi.importer.snapshot,{instance:bindings.a,key:keys.b}),/INSTANCE_CREDENTIAL/);
 const upper={a:upperSubmissionId('a',1),b:upperSubmissionId('b',1)},scan='capture-'+randomUUID();assert.ok(upper.a>=2&&upper.b>=2);
 const first=readSubmissionPage('a',1,{after:0,upper:upper.a,limit:1});const args={instance:bindings.a,key:keys.a,scan,...first};
 assert.equal(await call('page',args),'staged');assert.equal(await call('page',args),'duplicate');const staged=await snap('a');assert.equal(staged.cursor,0);assert.equal(staged.captures.length,0);assert.equal(staged.events.length,0);
 await assert.rejects(call('finish',{instance:bindings.a,key:keys.a,scan,observations:[]}),/TRAVERSAL_INCOMPLETE/);
 await stop('SIGKILL');await start();assert.deepEqual(await snap('a'),staged);results.push({name:'Actual backend restart preserves partial native page without advancing cursor or exposing captures',staged});
 const changed=structuredClone(args);changed.items[0].results.firstname='changed';await assert.rejects(call('page',changed),/CAPTURE_DIGEST/);assert.deepEqual(await snap('a'),staged);
 for(const t of ['a','b']){
  const run=t==='a'?scan:'capture-'+randomUUID();let after=t==='a'?first.next:0;
  for(let n=0;n<128;n++){const page=readSubmissionPage(t,1,{after,upper:upper[t],limit:1});await call('page',{instance:bindings[t],key:keys[t],scan:run,...page});after=page.next;if(page.complete)break;if(n===127)throw Error('PAGE_CAP');}
  const state=await snap(t),ids=[...new Set(state.pending.items.map(i=>i.contactId).filter(i=>i!==null))],observations=ids.map(id=>readEmailSuppression(t,id));
  if(observations.length)await assert.rejects(call('finish',{instance:bindings[t],key:keys[t],scan:run,observations:observations.slice(1)}),/CONSENT_COVERAGE/);
  const request={instance:bindings[t],key:keys[t],scan:run,observations},done=await call('finish',request),afterCommit=await snap(t);assert.equal(done.added,state.pending.items.length);assert.equal(afterCommit.cursor,upper[t]);assert.equal(afterCommit.pending,null);
  const repeat=await call('finish',request);assert.equal(repeat.duplicate,true);assert.deepEqual(await snap(t),afterCommit);results.push({name:'Native '+t+' traversal commits capture, suppression and attributed events atomically; repeat finish has no effects',result:done,snapshot:afterCommit});
 }
 const beforeRestart={a:await snap('a'),b:await snap('b')};await stop('SIGKILL');await start();assert.deepEqual(await snap('a'),beforeRestart.a);assert.deepEqual(await snap('b'),beforeRestart.b);
 const expectedPath=join(scratch,'expected.json');writeFileSync(expectedPath,JSON.stringify(beforeRestart),{mode:0o600});
 const fresh=execFileSync(process.execPath,[directory+'capture/readback.mjs',authPath,expectedPath],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});writeFileSync(output+'fresh-process-readback.txt',fresh);
 for(const t of ['a','b']){
  const before=await snap(t),run='idle-'+randomUUID(),limit=upperSubmissionId(t,1,before.cursor);assert.equal(limit,before.cursor,'No new native capture expected during bounded idle check');
  const page=readSubmissionPage(t,1,{after:before.cursor,upper:limit,limit:1});await call('page',{instance:bindings[t],key:keys[t],scan:run,...page});
  const observations=before.suppression.map(s=>readEmailSuppression(t,s.data.contactId));const result=await call('finish',{instance:bindings[t],key:keys[t],scan:run,observations});assert.equal(result.added,0);assert.equal(result.suppressionChanges,0);
  const after=await snap(t);assert.deepEqual(after.captures,before.captures);assert.deepEqual(after.events,before.events);results.push({name:'Idle '+t+' traversal writes no duplicate capture or audit event',result});
 }
 if(withOutage)await exerciseOutage({call,snap,bindings,keys,start,stop,results});
 const typecheck=execFileSync('pnpm',['exec','tsc','--noEmit','-p',join(scratch,'app/convex/tsconfig.json')],{cwd:resolve(directory,'../..'),encoding:'utf8',stdio:['ignore','pipe','pipe']});writeFileSync(output+'typecheck.txt',typecheck+'exit 0\n');
 writeFileSync(output+'result.json',JSON.stringify({status:'PASS',level:'SERVICE native form/submission APIs and isolated local Convex; synthetic identities; no CRM integration',results,lifecycle,backendVersion:version,backendSha256:createHash('sha256').update(readFileSync(cached)).digest('hex'),privateHomeIsolated:true,credentialsSaved:true,freshProcessReadback:true,nativeWrites:withOutage?{formSubmissions:4,suppressions:1}:0,webhooksConfigured:0,callbackOutageExercised:withOutage,limits:[...(withOutage?['Native deletion and webhook queue redelivery not exercised']:['No callback outage or consent flips exercised']),'No production identity/I1/CRM applyChange integration','DNC absence is not marketing opt-in']},null,2)+'\n');console.log('PASS durable native capture: '+(starts-1)+' actual backend restarts, A/B scope, atomic finalization, duplicate and idle checks'+(withOutage?', callback outage and current suppression':'')+'.');
}catch(error){writeFileSync(join(scratch,'failure.log'),String(error.stack??error),{mode:0o600});writeFileSync(output+'failure.json',JSON.stringify({message:'Capture run stopped; detailed error retained privately',resultsCompleted:results.length,lifecycle,scratch},null,2)+'\n');console.error('Capture run failed; inspect private failure and backend logs.');process.exitCode=1;}
finally{await stop();writeFileSync(join(scratch,'backend.log'),logs,{mode:0o600});}
