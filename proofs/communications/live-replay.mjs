import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, symlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { matchReply } from './adapter.mjs';
import { SendLedger } from './send-ledger.mjs';
import { verifiedReplyReference } from './receipt-reference.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),privateDir=join(here,'.private');
const A='shakur@envoylogic.com',B='reply@repliedfor.com';
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const safeWrite=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const resuming=['--prepare-resume','--resume-reviewed'].includes(process.argv[2]);
const originalPlanPath=join(privateDir,'live-plan.json');
const ledgerPath=join(privateDir,'send-ledger.jsonl'),planPath=join(privateDir,resuming?'resume-plan.json':'live-plan.json');
const ledger=new SendLedger(ledgerPath);
mkdirSync(privateDir,{recursive:true,mode:0o700});
if(process.argv[2]==='--initialize-ledger'){
  await ledger.initialize();console.log('Initialized persistent send ledger once. No provider calls.');process.exit(0);
}
if(process.argv[2]==='--prepare'){
  assert.ok(existsSync(ledgerPath),'Initialize the persistent ledger explicitly first');
  assert.ok(!existsSync(planPath),'Existing plan must be reviewed, never silently replaced');
  const run=randomUUID();
  const message=(name,from,to,subject,replyTo)=>({name,from,to,subject,messageId:`<remold-p5-${run}-${name}@repliedfor.com>`,text:`Remold controlled integration test ${run}, ${name}. No customer outreach.`,...(replyTo?{inReplyTo:replyTo}:{} )});
  const P1=message('P1',A,B,`Remold P5 test ${run} P`);
  const Q1=message('Q1',B,A,`Remold P5 test ${run} Q`);
  const reply=message('reply-P',B,A,'Re: '+P1.subject,P1.messageId);reply.text='Yes, stop this controlled test sequence.';
  const Q2=message('Q2',B,A,Q1.subject,Q1.messageId),Q3=message('Q3',B,A,Q1.subject,Q1.messageId);
  const plan={version:1,run,mailboxes:[A,B],capPerRolling24h:5,messages:[P1,Q1,reply,Q2,Q3],plannedCounts:{[A]:1,[B]:4},qOffsetsMs:[0,120000,240000],observeMs:540000,calendarCalls:0,originalTwoGoogleProof:false};
  safeWrite(planPath,plan);console.log(JSON.stringify({planPath,planSha256:hash(readFileSync(planPath)),plannedCounts:plan.plannedCounts,providerCalls:0}));process.exit(0);
}
if(process.argv[2]==='--prepare-resume'){
  assert.ok(!existsSync(planPath),'Never replace a resume plan');
  const original=json(originalPlanPath),failed=json(join(here,'evidence/live-replay-first-failure.json'));
  assert.equal(failed.planSha256,hash(readFileSync(originalPlanPath)));assert.deepEqual(failed.receipts.map(x=>x.name),['P1','Q1']);
  const diagnostic=json(join(here,'evidence/receipt-diagnostic-gmail.json')).providerP1;
  const reference=verifiedReplyReference(failed.receipts[0],{id:diagnostic.id,threadId:diagnostic.thread,payload:{headers:[{name:'From',value:diagnostic.from},{name:'To',value:diagnostic.to},{name:'Message-ID',value:diagnostic.messageId}]}});
  const plan={...original,resume:true,originalPlanSha256:failed.planSha256,priorEvidenceSha256:hash(readFileSync(join(here,'evidence/live-replay-first-failure.json'))),verifiedP1Reference:reference,unsentNames:['reply-P','Q2','Q3'],newSendCounts:{[A]:0,[B]:3},messages:original.messages.map(m=>m.name==='reply-P'?{...m,inReplyTo:reference}:m)};
  safeWrite(planPath,plan);console.log(JSON.stringify({planSha256:hash(readFileSync(planPath)),newSendCounts:plan.newSendCounts,providerCalls:0}));process.exit(0);
}
if(!['--run-reviewed','--resume-reviewed'].includes(process.argv[2]) || process.argv.length!==4){console.log('Use --initialize-ledger once, --prepare, then root-reviewed --run-reviewed <planSha256>.');process.exit(0)}
const expected=process.argv[3];assert.equal(hash(readFileSync(planPath)),expected,'Reviewed plan changed');
const plan=json(planPath);assert.equal(plan.version,1);assert.deepEqual(plan.mailboxes,[A,B]);assert.equal(plan.capPerRolling24h,5);assert.deepEqual(plan.qOffsetsMs,[0,120000,240000]);assert.equal(plan.observeMs,540000);
assert.deepEqual(plan.messages.map(x=>x.name),['P1','Q1','reply-P','Q2','Q3']);
const [P1,Q1,reply,Q2,Q3]=plan.messages;
assert.deepEqual(plan.messages.map(x=>[x.from,x.to]),[[A,B],[B,A],[B,A],[B,A],[B,A]]);
assert.equal(reply.inReplyTo,resuming?plan.verifiedP1Reference:P1.messageId);assert.equal(Q2.inReplyTo,Q1.messageId);assert.equal(Q3.inReplyTo,Q1.messageId);
for(const message of plan.messages){assert.match(message.messageId,/^<remold-p5-[a-zA-Z0-9-]+@repliedfor\.com>$/);assert.ok(!/[\r\n]/.test(message.subject));}
const validated=JSON.parse(execFileSync('python3',[join(here,'purelymail-message.py')],{input:JSON.stringify({action:resuming?'validate-resume':'validate-plan',messages:resuming?plan.messages.slice(2):plan.messages,...(resuming?{verifiedP1Reference:plan.verifiedP1Reference}:{})}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
assert.equal(validated.validated,resuming?3:5);
let prior;
if(resuming){
 assert.equal(plan.originalPlanSha256,hash(readFileSync(originalPlanPath)));
 assert.equal(plan.priorEvidenceSha256,hash(readFileSync(join(here,'evidence/live-replay-first-failure.json'))));
 prior=json(join(here,'evidence/live-replay-first-failure.json'));assert.deepEqual(prior.receipts.map(r=>r.name),['P1','Q1']);
 assert.deepEqual(plan.unsentNames,['reply-P','Q2','Q3']);assert.deepEqual(plan.newSendCounts,{[A]:0,[B]:3});
 await ledger.transaction(rows=>{
  const reservations=rows.filter(r=>r.kind==='reservation'&&r.id.startsWith(plan.run+'-'));
  assert.deepEqual(reservations.map(r=>r.id),[plan.run+'-P1',plan.run+'-Q1']);
  for(const message of [P1,Q1]){const id=plan.run+'-'+message.name;const r=reservations.find(r=>r.id===id);assert.equal(r.contentHash,hash(JSON.stringify(message)));assert.equal(r.from,message.from);assert.equal(r.to,message.to);const outcomes=rows.filter(r=>r.kind==='outcome'&&r.id===id);assert.equal(outcomes.at(-1)?.status,'accepted');}
  return {result:true};
 });
}
const startedPath=join(privateDir,resuming?'resume-started.json':'run-started.json');assert.ok(!existsSync(startedPath),'Run previously started; never automatically replay uncertain sends');
const ready=json(join(here,'evidence/oauth-ready.json')),connection=json(join(ready.privateDirectory,'mailbox-A.json'));
assert.equal(connection.email,A);assert.ok(connection.tokens.scope.split(' ').includes('https://www.googleapis.com/auth/gmail.send'));
const credentials=Object.fromEntries(readFileSync(join(root,'.env.remold-sandbox.local'),'utf8').split(/\r?\n/).filter(s=>/^GOOGLE_(CLIENT_ID|CLIENT_SECRET)=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).replace(/^(["'])(.*)\1$/,'$2')]}));
const auth=new OAuth2Client(credentials.GOOGLE_CLIENT_ID,credentials.GOOGLE_CLIENT_SECRET);auth.setCredentials(connection.tokens);
const gmail=async(path,options={})=>{
  const token=(await auth.getAccessToken()).token;
  const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('GMAIL_HTTP_'+response.status);
  return response.json();
};
const purely=request=>{
  const output=execFileSync('python3',[join(here,'purelymail-message.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']});
  const result=JSON.parse(output);assert.equal(result.ok,true);return result;
};
if(resuming){
 const metadata=await gmail('messages/'+prior.receipts[0].providerRef+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To');
 assert.equal(verifiedReplyReference(prior.receipts[0],metadata),plan.verifiedP1Reference,'Provider reference must be freshly verified, never user supplied');
}
const baseline=json(join(here,'evidence/purelymail-connection.json')).imap.baseline;
const contract=join(root,'proofs/contract'),manifest=json(join(contract,'evidence/contract-hashes.json'));
for(const [path,digest] of Object.entries(manifest.sources))assert.equal(hash(readFileSync(join(contract,path))),digest,'Frozen H0 changed');
const scratch=mkdtempSync(join(tmpdir(),'remold-p5-live-'));
cpSync(join(contract,'convex'),join(scratch,'convex'),{recursive:true});writeFileSync(join(scratch,'convex.json'),'{}');
writeFileSync(join(scratch,'package.json'),JSON.stringify({name:'communications-live',type:'module',dependencies:{convex:'1.46.0'}}));symlinkSync(join(here,'node_modules'),join(scratch,'node_modules'),'dir');
const cli=join(here,'node_modules/convex/bin/main.js'),env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const rootEnv=()=>existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null,before=rootEnv();
const evidence={level:'LIVE reciprocal mail; SERVICE local frozen H0; SIM tenant/member bindings',planSha256:expected,contractManifest:manifest.manifestSha256,receipts:resuming?[...prior.receipts]:[],observed:[],cutoffChecks:[],actualMailAccepted:resuming?{...prior.actualMailAccepted}:{[A]:0,[B]:0},resuming,priorSendsRepeated:false,resumeH0State:resuming?'new isolated H0 fixture for unsent effects; prior provider receipts retained, no original workflow-state recovery claim':null,calendarCalls:0,twoGoogleMailboxes:false,originalSameSourceTwoContactProof:false};
let logs='';
const backend=spawn(process.execPath,[cli,'dev','--typecheck','disable','--tail-logs','disable','--local-cloud-port','3520','--local-site-port','3521'],{cwd:scratch,env,detached:true,stdio:['ignore','pipe','pipe']});
backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
try{
  const deadline=Date.now()+180000;while(!logs.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>deadline)throw new Error('BACKEND_NOT_READY');await delay(200)}
  assert.match(readFileSync(join(scratch,'.env.local'),'utf8'),/^CONVEX_URL=http:\/\/127\.0\.0\.1:3520$/m);
  const client=new ConvexHttpClient('http://127.0.0.1:3520',{logger:false});
  const call=(name,args)=>client.mutation(anyApi.harness[name],args);
  const f=JSON.parse(execFileSync(process.execPath,[cli,'run','harness:seed',JSON.stringify({run:plan.run,tokens:Array.from({length:10},randomUUID)})],{cwd:scratch,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  await call('grant',{token:f.A.sessions.owner,target:f.A.actors.manager,capability:'marketing.send',scope:{kind:'bindings',bindings:[f.A.binding,f.A.bindingY],maxAmountMinor:1000,currency:'USD',maxRecipients:1},mode:'direct',delegate:false,expires:Date.now()+900000});
  const propose=(name,binding,recipient,content)=>call('propose',{token:f.A.sessions.manager,logical:plan.run+'-'+name,binding,capability:'marketing.send',payload:{content,audience:[recipient],audienceVersion:1,destination:'A',schedule:0,amountMinor:0,currency:'USD',workflowVersion:1},reservationUnits:1,maxSteps:1});
  const claim=id=>call('claim',{token:f.A.sessions.manager,id,worker:'p5-live-fixture'});
  async function send(message,binding,recipient){
    const id=await propose(message.name,binding,recipient,JSON.stringify(message));
    const c=await claim(id),p=await call('permit',{token:f.A.adapter,id,...c,worker:'p5-live-fixture'});
    const {expires,maxUnits,maxRecipients,...consume}=p;await call('consume',{token:f.A.adapter,...consume});
    const reservation=await ledger.reserve({id:plan.run+'-'+message.name,from:message.from,to:message.to,contentHash:hash(JSON.stringify(message))});
    assert.equal(reservation.shouldDispatch,true,'Existing attempt cannot be dispatched again');
    let providerRef, providerThread;
    try {
    if(message.from===A){
      const raw=[`From: ${A}`,`To: ${B}`,`Subject: ${message.subject}`,`Message-ID: ${message.messageId}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',''+message.text].join('\r\n');
      const accepted=await gmail('messages/send',{method:'POST',body:JSON.stringify({raw:Buffer.from(raw).toString('base64url')})});providerRef=accepted.id;providerThread=accepted.threadId;
    }else{purely({...message,action:'send',...(resuming?{verifiedP1Reference:plan.verifiedP1Reference}:{})});providerRef=message.messageId;}
    } catch(error) {
      await ledger.outcome(reservation.id,'unknown');
      await call('fail',{token:f.A.adapter,id,...c,retryable:false});
      evidence.receipts.push({name:message.name,outcome:'unknown',at:new Date().toISOString()});
      throw error;
    }
    await ledger.outcome(reservation.id,'accepted');evidence.actualMailAccepted[message.from]++;
    evidence.receipts.push({name:message.name,messageId:message.messageId,providerRef,...(providerThread?{thread:providerThread}:{}),at:new Date().toISOString()});
    await call('reconcile',{token:f.A.adapter,id,...c,providerRef,usage:1});
  }
  async function waitForMessage(message,until){
    while(Date.now()<until){
      if(message.to===B){const got=purely({action:'read-test',messageId:resuming&&message.name==='P1'?plan.verifiedP1Reference:message.messageId,baseline,...(resuming?{verifiedP1Reference:plan.verifiedP1Reference}:{})});if(got.messages.length){assert.equal(got.messages.length,1);const m=got.messages[0];assert.equal(m.from,A);assert.equal(m.to,B);evidence.observed.push({name:message.name,at:new Date().toISOString(),uid:m.uid});return m;}}
      else{
        const found=await gmail('messages?includeSpamTrash=true&q='+encodeURIComponent('rfc822msgid:'+message.messageId));
        if(found.messages?.length){assert.equal(found.messages.length,1);const m=await gmail('messages/'+found.messages[0].id+'?format=metadata');
          const headers=Object.fromEntries(m.payload.headers.map(h=>[h.name.toLowerCase(),h.value]));
          assert.equal(headers['message-id'],message.messageId);assert.equal(headers.from,B);assert.equal(headers.to,A);
          if(message.inReplyTo)assert.equal(headers['in-reply-to'],message.inReplyTo);
          evidence.observed.push({name:message.name,at:new Date().toISOString(),providerId:m.id,thread:m.threadId});return {id:m.id,thread:m.threadId,headers};}
      }
      await delay(3000);
    }
    throw new Error('CONTROLLED_MESSAGE_NOT_RECEIVED');
  }
  writeFileSync(startedPath,JSON.stringify({planSha256:expected,at:Date.now()})+'\n',{flag:'wx',mode:0o600});
  const start=Date.now();
  if(!resuming){await send(P1,f.A.binding,'recipient');await send(Q1,f.A.bindingY,'recipient-Y');}
  let lastQAccepted=resuming?Date.parse(prior.receipts.find(r=>r.name==='Q1').at):Date.now();
  const qStart=Date.now();
  await waitForMessage(P1,start+90000);
  const qObserved=await waitForMessage(Q1,start+90000);
  await send(reply,f.A.bindingY,'recipient-Y');
  const pReply=await waitForMessage(reply,start+115000);
  const context={org:f.A.org,binding:f.A.binding,account:connection.subject,mailbox:A,contact:B,thread:evidence.receipts.find(r=>r.name==='P1').thread,messageId:resuming?plan.verifiedP1Reference:P1.messageId,sequence:'P',replyOwner:'personal-sales'};
  const incoming={org:f.A.org,binding:f.A.binding,account:connection.subject,mailbox:A,from:B,to:[A],thread:pReply.thread,id:pReply.id,inReplyTo:pReply.headers['in-reply-to']};
  assert.equal(matchReply([context],incoming)?.sequence,'P');
  assert.equal(matchReply([context],{...incoming,id:qObserved.id,thread:qObserved.thread,inReplyTo:qObserved.headers['in-reply-to']}),null);
  await call('callback',{token:f.A.adapter,binding:f.A.binding,eventId:pReply.id,body:JSON.stringify({version:1,state:'suppressed',channel:'email',purpose:'marketing'})});
  for(const [index,message] of [Q2,Q3].entries()){
    await delay(Math.max(0,(resuming?Math.max(qStart+120000,lastQAccepted+120000):qStart+plan.qOffsetsMs[index+1])-Date.now()));
    const id=await propose('P'+(index+2),f.A.binding,'recipient','Never dispatched');
    await assert.rejects(claim(id),/consent denied/);evidence.cutoffChecks.push({step:index+2,at:new Date().toISOString(),denied:true});
    await send(message,f.A.bindingY,'recipient-Y');lastQAccepted=Date.now();await waitForMessage(message,Date.now()+60000);
  }
  await delay(Math.max(0,start+plan.observeMs-Date.now()));
  evidence.elapsedMs=Date.now()-start;assert.deepEqual(evidence.actualMailAccepted,{[A]:1,[B]:4});assert.equal(evidence.observed.length,5);
  evidence.status='PASS';console.log('PASS bounded reciprocal P/Q test; A1 B4; original two-Google/calendar proofs remain open');
}catch(error){evidence.status='FAIL_OR_UNKNOWN';evidence.errorType=error.name;evidence.failureCode=/^[A-Z0-9_]+$/.test(error.message)?error.message:'INSPECT_PRIVATE_REHEARSAL';process.exitCode=1;console.error('Live proof stopped; do not retry sends. Review ledger and safe evidence.');}
finally{evidence.rootEnvironmentUnchanged=rootEnv()===before;safeWrite(join(here,resuming?'evidence/live-resume.json':'evidence/live-replay.json'),evidence);writeFileSync(join(scratch,'backend.log'),logs);try{process.kill(-backend.pid,'SIGTERM')}catch{}assert.equal(rootEnv(),before)}
