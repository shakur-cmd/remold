import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,openSync,writeSync,fsyncSync,closeSync,mkdirSync,existsSync,cpSync,mkdtempSync,symlinkSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { SendLedger } from './send-ledger.mjs';
import { A,B,C,makePlan,validatePlan,capacity,validateRelease,runSequence } from './same-sender-core.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),privateDir=join(here,'.private');
const hash=x=>createHash('sha256').update(x).digest('hex'),json=p=>JSON.parse(readFileSync(p,'utf8'));
const planPath=join(privateDir,'same-sender-plan.json'),ledgerPath=join(privateDir,'send-ledger.jsonl'),startedPath=join(privateDir,'same-sender-started.json');
const ledger=new SendLedger(ledgerPath),mode=process.argv[2];
assert.ok(existsSync(ledgerPath),'Existing shared ledger required; never initialize another ledger');
if(mode==='--prepare'){
 assert.equal(process.argv.length,3);const plan=makePlan(randomUUID());await capacity(ledger,plan);writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({planSha256:hash(readFileSync(planPath)),plannedCounts:plan.plannedCounts,providerCalls:0}));process.exit(0);
}
assert.ok(['--preflight','--run-reviewed'].includes(mode)&&process.argv.length===4,'Use --prepare, --preflight <hash>, or root-released --run-reviewed <hash>');
const expected=process.argv[3];assert.equal(hash(readFileSync(planPath)),expected,'Reviewed plan changed');const plan=json(planPath);validatePlan(plan);
const replyTemplate=plan.messages[2],replyForValidation={...replyTemplate,inReplyTo:plan.messages[0].messageId};
execFileSync('python3',['-c','import json,sys; from purelymail_payload import validate_send; validate_send(json.load(sys.stdin)); print("payload valid")'],{cwd:here,input:JSON.stringify(replyForValidation),encoding:'utf8',stdio:['pipe','pipe','pipe']});
const readiness=await capacity(ledger,plan);
if(mode==='--preflight'){console.log(JSON.stringify({planSha256:expected,readiness,providerCalls:0,releasePresent:existsSync(join(privateDir,'same-sender-release.json')),started:existsSync(startedPath)}));process.exit(0);}
validateRelease(json(join(privateDir,'same-sender-release.json')),expected);
assert.ok(!existsSync(startedPath),'One-shot fixture already started; no automatic resend or resume');
const contract=join(root,'proofs/contract'),manifest=json(join(contract,'evidence/contract-hashes.json'));
for(const [path,digest] of Object.entries(manifest.sources))assert.equal(hash(readFileSync(join(contract,path))),digest,'Frozen H0 changed');
const scratch=mkdtempSync(join(tmpdir(),'remold-p5-same-sender-'));cpSync(join(contract,'convex'),join(scratch,'convex'),{recursive:true});writeFileSync(join(scratch,'convex.json'),'{}');writeFileSync(join(scratch,'package.json'),JSON.stringify({name:'same-sender-proof',type:'module',dependencies:{convex:'1.46.0'}}));symlinkSync(join(here,'node_modules'),join(scratch,'node_modules'),'dir');
const cli=join(here,'node_modules/convex/bin/main.js'),env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const rootHash=()=>existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null,rootBefore=rootHash();
const events=[],evidence={planSha256:expected,level:'Prepared LIVE same-sender fixture; local H0 SERVICE with SIM identities',contractManifest:manifest.manifestSha256,events,cReceiptReadAccount:C,calendarCalls:0};
function record(event){events.push(event);const data=JSON.stringify(evidence,null,2)+'\n',fd=openSync(join(here,'evidence/same-sender/live-result.json'),'w',0o600);try{writeSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}}
let logs='';const backend=spawn(process.execPath,[cli,'dev','--typecheck','disable','--tail-logs','disable','--local-cloud-port','3580','--local-site-port','3581'],{cwd:scratch,env,detached:true,stdio:['ignore','pipe','pipe']});for(const s of[backend.stdout,backend.stderr])s.on('data',b=>logs+=b);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const deadline=Date.now()+180000;while(!logs.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>deadline)throw Error('BACKEND_NOT_READY');await wait(100);}
 assert.match(readFileSync(join(scratch,'.env.local'),'utf8'),/^CONVEX_URL=http:\/\/127\.0\.0\.1:3580$/m);
 const client=new ConvexHttpClient('http://127.0.0.1:3580',{logger:false}),call=(name,args)=>client.mutation(anyApi.harness[name],args);
 const f=JSON.parse(execFileSync(process.execPath,[cli,'run','harness:seed',JSON.stringify({run:plan.run,tokens:Array.from({length:10},randomUUID)})],{cwd:scratch,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 await call('grant',{token:f.A.sessions.owner,target:f.A.actors.manager,capability:'marketing.send',scope:{kind:'bindings',bindings:[f.A.binding,f.A.bindingY],maxAmountMinor:1000,currency:'USD',maxRecipients:1},mode:'direct',delegate:false,expires:Date.now()+900000});
 const propose=(name,binding,recipient,content)=>call('propose',{token:f.A.sessions.manager,logical:plan.run+'-'+name,binding,capability:'marketing.send',payload:{content,audience:[recipient],audienceVersion:1,destination:'A',schedule:0,amountMinor:0,currency:'USD',workflowVersion:1},reservationUnits:1,maxSteps:1});
 const claim=id=>call('claim',{token:f.A.sessions.manager,id,worker:'same-sender-proof'});
 // No provider credential is loaded before exact plan/release, shared capacity and one-shot checks.
 const fd=openSync(startedPath,'wx',0o600);try{writeSync(fd,JSON.stringify({planSha256:expected,at:Date.now()})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const connection=json(join(json(join(here,'evidence/oauth-ready.json')).privateDirectory,'mailbox-A.json'));assert.equal(connection.email,A);
 for(const scope of['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'])assert.ok(connection.tokens.scope.split(' ').includes(scope));
 const credentials=Object.fromEntries(readFileSync(join(root,'.env.remold-sandbox.local'),'utf8').split(/\r?\n/).filter(s=>/^GOOGLE_(CLIENT_ID|CLIENT_SECRET)=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).replace(/^(["'])(.*)\1$/,'$2')]}));
 const auth=new OAuth2Client(credentials.GOOGLE_CLIENT_ID,credentials.GOOGLE_CLIENT_SECRET);auth.setCredentials(connection.tokens);
 const gmail=async(path,options={})=>{const token=(await auth.getAccessToken()).token;const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('GMAIL_HTTP_'+response.status);return response.json();};
 const purely=request=>{const r=JSON.parse(execFileSync('python3',[join(here,'purelymail-message.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}));assert.equal(r.ok,true);return r;};
 const baseline=json(join(here,'evidence/purelymail-connection.json')).imap.baseline;
 async function dispatch(message,thread){
  const binding=message.name==='P1'?f.A.binding:f.A.bindingY,recipient=message.name==='P1'?'recipient':'recipient-Y';
  const id=await propose(message.name,binding,recipient,JSON.stringify(message)),c=await claim(id),permit=await call('permit',{token:f.A.adapter,id,...c,worker:'same-sender-proof'});
  const{expires,maxUnits,maxRecipients,...consume}=permit;await call('consume',{token:f.A.adapter,...consume});
  const reservationId=plan.run+'-'+message.name,contentHash=hash(JSON.stringify(message));assert.equal((await ledger.reserve({id:reservationId,from:message.from,to:message.to,contentHash})).shouldDispatch,true);
  record({kind:'reserved',name:message.name,reservationId,contentHash,from:message.from,to:message.to,at:Date.now()});
  let accepted;
  try{
   if(message.from===A){assert.ok([B,C].includes(message.to));const raw=[`From: ${A}`,`To: ${message.to}`,`Subject: ${message.subject}`,`Message-ID: ${message.messageId}`,...(message.inReplyTo?[`In-Reply-To: ${message.inReplyTo}`,`References: ${message.inReplyTo}`]:[]),'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',message.text].join('\r\n');accepted=await gmail('messages/send',{method:'POST',body:JSON.stringify({raw:Buffer.from(raw).toString('base64url'),...(thread?{threadId:thread}:{})})});}
   else{assert.equal(message.from,B);assert.equal(message.to,A);purely({...message,action:'send',verifiedP1Reference:message.inReplyTo});accepted={id:message.messageId};}
  }catch(error){await ledger.outcome(reservationId,'unknown');await call('unknown',{token:f.A.adapter,id,...c});record({kind:'unknown',name:message.name,reservationId,at:Date.now()});throw Error('SEND_OUTCOME_UNKNOWN');}
  const acceptedAt=Date.now();await ledger.outcome(reservationId,'accepted');const receipt={name:message.name,reservationId,contentHash,providerRef:accepted.id,...(accepted.threadId?{thread:accepted.threadId}:{}),acceptedAt};record({kind:'provider-accepted',receipt});
  await call('reconcile',{token:f.A.adapter,id,...c,providerRef:accepted.id,usage:1});return receipt;
 }
 async function observeP(reference){const until=Date.now()+90000;while(Date.now()<until){const r=purely({action:'read-test',messageId:reference,verifiedP1Reference:reference,baseline});if(r.messages.length){assert.equal(r.messages.length,1);assert.equal(r.messages[0].from,A);assert.equal(r.messages[0].to,B);record({kind:'P1-received',messageId:reference,uid:r.messages[0].uid});return;}await wait(3000);}throw Error('P1_NOT_RECEIVED');}
 async function observeReply(receipt,reference,until){while(Date.now()<until){const r=await gmail('messages?includeSpamTrash=true&q='+encodeURIComponent('rfc822msgid:'+receipt.providerRef));if(r.messages?.length){assert.equal(r.messages.length,1);const m=await gmail('messages/'+r.messages[0].id+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To&metadataHeaders=In-Reply-To');const h=Object.fromEntries(m.payload.headers.map(h=>[h.name.toLowerCase(),h.value]));assert.equal(h['message-id'],receipt.providerRef);assert.equal(h['in-reply-to'],reference);return{id:m.id,from:h.from,to:[h.to],thread:m.threadId,inReplyTo:h['in-reply-to']};}await wait(3000);}throw Error('STRIPPED_REPLY_NOT_RECEIVED');}
 const result=await runSequence({plan,dispatch,metadata:receipt=>gmail('messages/'+receipt.providerRef+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject'),observeP,observeReply,
 suppressP:async eventId=>{await call('callback',{token:f.A.adapter,binding:f.A.binding,eventId,body:JSON.stringify({version:1,state:'suppressed',channel:'email',purpose:'marketing'})});},
 pBlocked:async name=>{const id=await propose(name,f.A.binding,'recipient','Suppressed fixture follow-up; never reserve or send');try{await claim(id);return false;}catch(e){if(!String(e.message).includes('consent denied'))throw e;return true;}},record,now:Date.now,wait});
 evidence.result=result;record({kind:'awaiting-root-exact-C-receipts',at:Date.now()});console.log('Same-sender sends/reply cutoff finished; C delivery remains awaiting root exact receipt checks.');
}catch(error){evidence.status='STOPPED_OR_UNKNOWN';evidence.failureCode=/^[A-Z0-9_]+$/.test(error.message)?error.message:'REVIEW_REQUIRED';record({kind:'stopped',at:Date.now()});console.error('Stopped; inspect durable ledger/evidence. Do not rerun.');process.exitCode=1;}
finally{writeFileSync(join(scratch,'backend.log'),logs);try{process.kill(-backend.pid,'SIGTERM');}catch{}assert.equal(rootHash(),rootBefore);}
