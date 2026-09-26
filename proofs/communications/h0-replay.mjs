import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { matchReply } from './adapter.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),contract=join(root,'proofs/contract');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(readFileSync(join(contract,'evidence/contract-hashes.json'),'utf8'));
for(const [path,digest] of Object.entries(manifest.sources))assert.equal(hash(readFileSync(join(contract,path))),digest,'Frozen H0 source changed');
const scratch=mkdtempSync(join(tmpdir(),'remold-communications-h0-'));
cpSync(join(contract,'convex'),join(scratch,'convex'),{recursive:true});
writeFileSync(join(scratch,'convex.json'),'{}');writeFileSync(join(scratch,'package.json'),JSON.stringify({name:'communications-h0',type:'module',dependencies:{convex:'1.46.0'}}));
symlinkSync(join(here,'node_modules'),join(scratch,'node_modules'),'dir');
const cli=join(here,'node_modules/convex/bin/main.js');
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const rootEnv=()=>existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null,before=rootEnv();
let logs='';const results=[];
const backend=spawn(process.execPath,[cli,'dev','--typecheck','disable','--tail-logs','disable','--local-cloud-port','3520','--local-site-port','3521'],{cwd:scratch,env,detached:true,stdio:['ignore','pipe','pipe']});
backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
  const deadline=Date.now()+180000;while(!logs.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>deadline)throw new Error('BACKEND_NOT_READY');await delay(200)}
  assert.match(readFileSync(join(scratch,'.env.local'),'utf8'),/^CONVEX_URL=http:\/\/127\.0\.0\.1:3520$/m);
  const client=new ConvexHttpClient('http://127.0.0.1:3520',{logger:false});
  const call=(name,args)=>client.mutation(anyApi.harness[name],args),read=(name,args)=>client.query(anyApi.harness[name],args);
  const seed=()=>JSON.parse(execFileSync(process.execPath,[cli,'run','harness:seed',JSON.stringify({run:randomUUID(),tokens:Array.from({length:10},randomUUID)})],{cwd:scratch,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  async function fixture(){const f=seed();await call('grant',{token:f.A.sessions.owner,target:f.A.actors.manager,capability:'marketing.send',scope:{kind:'bindings',bindings:[f.A.binding,f.A.bindingY],maxAmountMinor:1000,currency:'USD',maxRecipients:1},mode:'direct',delegate:false,expires:Date.now()+60000});return f;}
  const propose=(f,key,binding=f.A.binding,recipient='recipient')=>call('propose',{token:f.A.sessions.manager,logical:key,binding,capability:'marketing.send',payload:{content:'synthetic communication',audience:[recipient],audienceVersion:1,destination:'A',schedule:0,amountMinor:0,currency:'USD',workflowVersion:1},reservationUnits:1,maxSteps:1});
  const claim=(f,id)=>call('claim',{token:f.A.sessions.manager,id,worker:'mail-fixture'});
  const permit=(f,id,c)=>call('permit',{token:f.A.adapter,id,...c,worker:'mail-fixture'});
  const consume=(f,p)=>{const{expires,maxUnits,maxRecipients,...args}=p;return call('consume',{token:f.A.adapter,...args})};
  const finish=(f,id,c)=>call('reconcile',{token:f.A.adapter,id,...c,providerRef:'sim-mail-'+randomUUID(),usage:1});
  const suppress=(f,eventId)=>call('callback',{token:f.A.adapter,binding:f.A.binding,eventId,body:JSON.stringify({version:1,state:'suppressed',channel:'email',purpose:'marketing'})});
  const f=await fixture(),sent=[];
  const first=await propose(f,'P-step1'),c1=await claim(f,first),p1=await permit(f,first,c1);await consume(f,p1);await finish(f,first,c1);sent.push('P1');
  const next=await propose(f,'P-step2'),c2=await claim(f,next);
  const sentContext={org:f.A.org,binding:f.A.binding,account:'synthetic-A',mailbox:'a@example.invalid',contact:'p@example.invalid',thread:'proof-thread',messageId:'<proof-1@example.invalid>',sequence:'P',replyOwner:'personal-sales'};
  const match=matchReply([sentContext],{...sentContext,from:'p@example.invalid',to:['a@example.invalid'],id:'reply',inReplyTo:sentContext.messageId,text:'Yes',autoSubmitted:false});assert.equal(match.sequence,'P');
  assert.equal(await suppress(f,'reply-1'),'applied');assert.equal(await suppress(f,'reply-1'),'duplicate');
  await assert.rejects(permit(f,next,c2),/consent denied/);
  for(let i=1;i<=3;i++){const id=await propose(f,'Q-step'+i,f.A.bindingY,'recipient-Y'),c=await claim(f,id),p=await permit(f,id,c);await consume(f,p);await finish(f,id,c);sent.push('Q'+i)}
  assert.deepEqual(sent,['P1','Q1','Q2','Q3']);results.push({name:'Stripped reply suppresses P final permit; Q retains three sends',pass:true,simSendReceipts:sent,nineMinuteLiveFixture:false});
  const f2=await fixture(),inflight=await propose(f2,'already-permitted'),c=await claim(f2,inflight),p=await permit(f2,inflight,c);
  await suppress(f2,'unsubscribe-race');assert.equal((await read('operation',{token:f2.A.sessions.owner,id:inflight})).state,'dispatching');
  await consume(f2,p);await finish(f2,inflight,c);assert.equal((await read('operation',{token:f2.A.sessions.owner,id:inflight})).state,'confirmed');
  const queued=await propose(f2,'later');await assert.rejects(claim(f2,queued),/consent denied/);
  results.push({name:'Already-permitted tail stays visible; later action refused after unsubscribe',pass:true});
  await assert.rejects(call('callback',{token:f2.B.adapter,binding:f2.A.binding,eventId:'foreign',body:JSON.stringify({version:2,state:'suppressed',channel:'email',purpose:'marketing'})}),/adapter|tenant|binding/);
  results.push({name:'Foreign mailbox adapter cannot attach callback to A binding',pass:true});
  assert.equal(rootEnv(),before);
  writeFileSync(join(here,'evidence/h0-service.json'),JSON.stringify({level:'SERVICE Convex; SIM identities/mail provider/reply',contractManifest:manifest.manifestSha256,results,rootEnvironmentUnchanged:true,actualMailSent:0,calendarCalls:0,oauthCovered:false},null,2)+'\n');
  console.log('PASS '+results.length+' communication/H0 groups; no real sends');
}catch(error){writeFileSync(join(here,'evidence/h0-service-failure.json'),JSON.stringify({results,error:String(error.message).slice(0,1000)},null,2));process.exitCode=1;console.error('Communication H0 rehearsal failed; see safe evidence');}
finally{writeFileSync(join(scratch,'backend.log'),logs);try{process.kill(-backend.pid,'SIGTERM')}catch{}assert.equal(rootEnv(),before)}
