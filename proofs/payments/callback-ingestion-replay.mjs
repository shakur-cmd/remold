// SERVICE/SIM replay of durable callback ingestion. Local Convex on 3620/3621, receiver on 3622,
// synthetic signing secret, in-process provider-state stub. No Stripe calls of any kind.
// The client sees production-style error redaction (callback/redact-hook.mjs) in every run.
import './callback/redact-hook.mjs';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,cpSync,readFileSync,writeFileSync,existsSync,symlinkSync,renameSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {trustedAdapter} from './adapter.mjs';
import {StripeFailure} from './stripe.mjs';

const here=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../',import.meta.url));
const out=here+'evidence/callback-ingestion/'+(process.env.CALLBACK_OUT??'fix/suite')+'/';
const PORTS={cloud:3620,site:3621,receiver:3622};
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.split('=')[1];

// Each mutant removes exactly one guard from the real source, in a private copy.
const MUTANTS={
 dedupe:{file:'convex/payments.ts',from:"if (old) {\n            if (old.digest !== a.digest)\n                deny('event integrity mismatch');\n            return false;\n        }\n        const { token, ...row } = a;",to:"const { token, ...row } = a;"},
 signature:{file:'webhooks.mjs',from:"if(!fields.filter(([k])=>k==='v1').some(([,value])=>{const actual=Buffer.from(value??'','hex');return actual.length===expected.length&&timingSafeEqual(actual,expected)}))throw new Error('Webhook signature refused');",to:''},
 account:{file:'callback-ingestion.mjs',from:'merchants.find(m=>m.account===event.account)',to:'merchants.find(()=>true)'},
 isolation:{file:'callback-ingestion.mjs',from:"try{items=await due(merchant,now());}catch(error){outcomes.push({merchant:merchant.name,result:'merchant_error',code:codeOf(error)});continue;}",to:'items=await due(merchant,now());'},
 classify:{file:'callback-ingestion.mjs',from:"if(status>=400&&status<500&&![408,409,429].includes(status))",to:'if(false)'},
 backoff:{file:'convex/callbackIngestion.ts',from:'if (retry && retry.nextAt > a.now) continue;',to:''},
 'attempt-cap':{file:'convex/callbackIngestion.ts',from:'const MAX_ATTEMPTS = 5,',to:'const MAX_ATTEMPTS = 1e9,'},
 'typed-refusal':{file:'convex/callbackIngestion.ts',from:"if (!doc) return { action: 'refuse' as const, code: 'unbound_document' };",to:''},
 unsupported:{file:'convex/callbackIngestion.ts',from:"if (!row.type.startsWith('invoice.')) return { action: 'refuse' as const, code: 'unsupported_event_type' };",to:''},
 park:{file:'callback-ingestion.mjs',from:'else await park(event.account,row);',to:';'},
};
const RUNS=[['baseline','none','fail'],['after','none','pass'],...Object.keys(MUTANTS).map(k=>['after',k,'fail'])];

if(process.argv.includes('--all'))await all();else await one(arg('mode')??'after',arg('mutant')??'none');

async function all(){
 mkdirSync(out,{recursive:true});const summary=[];
 for(const [mode,mutant,expected] of RUNS){
  const code=await new Promise(r=>spawn(process.execPath,[fileURLToPath(import.meta.url),'--mode='+mode,'--mutant='+mutant],{stdio:'inherit',env:process.env}).once('close',r));
  const result=JSON.parse(readFileSync(out+label(mode,mutant)+'.json','utf8'));
  summary.push({mode,mutant,expected,exit:code,failedCases:result.cases.filter(c=>!c.pass).map(c=>c.name),meetsExpectation:expected==='pass'?code===0&&result.cases.every(c=>c.pass):result.cases.some(c=>!c.pass)});
 }
 writeFileSync(out+'summary.json',JSON.stringify(summary,null,1)+'\n');
 console.log('\nSUMMARY');for(const s of summary)console.log(`${s.mode}/${s.mutant}: expected ${s.expected}, failed cases [${s.failedCases.join(', ')}] -> ${s.meetsExpectation?'OK':'UNEXPECTED'}`);
 process.exit(summary.every(s=>s.meetsExpectation)?0:1);
}
function label(mode,mutant){return mutant==='none'?mode:'mutant-'+mutant;}

async function one(mode,mutant){
 assert.ok(['baseline','after'].includes(mode));assert.ok(mutant==='none'||(mode==='after'&&MUTANTS[mutant]));
 for(const port of Object.values(PORTS))assert.equal(await inUse(port),false,'Port busy: '+port);
 mkdirSync(here+'private',{recursive:true,mode:0o700});mkdirSync(out,{recursive:true});
 if(!existsSync(here+'node_modules'))symlinkSync(root+'node_modules',here+'node_modules','dir');
 const cwd=mkdtempSync(here+'private/callback-'+label(mode,mutant)+'-');
 cpSync(here+'convex',cwd+'/convex',{recursive:true});
 // Same additive-schema pattern as recurring/: the frozen schema is imported, not edited.
 renameSync(cwd+'/convex/schema.ts',cwd+'/convex/payment_schema.ts');
 for(const name of ['schema.ts','callbackIngestion.ts'])cpSync(here+'callback/'+name,cwd+'/convex/'+name);
 for(const name of ['tsconfig.json','package.json','webhooks.mjs','callback-ingestion.mjs'])cpSync(here+name,cwd+'/'+name);
 writeFileSync(cwd+'/convex.json','{"functions":"convex"}');symlinkSync(root+'node_modules',cwd+'/node_modules','dir');
 if(mutant!=='none'){const m=MUTANTS[mutant],path=cwd+'/'+m.file,text=readFileSync(path,'utf8');assert.equal(text.split(m.from).length,2,'Mutant anchor must match exactly once: '+mutant);writeFileSync(path,text.replace(m.from,m.to));}
 const {verifyStripe}=await import(pathToFileURL(cwd+'/webhooks.mjs'));
 const {createReceiver,drain,convexDeps}=await import(pathToFileURL(cwd+'/callback-ingestion.mjs'));

 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1',CI:'1'};
 const cli=root+'node_modules/convex/bin/main.js';let backend,log='';
 const run=(path,args={})=>{try{const t=execFileSync(process.execPath,[cli,'run',path,JSON.stringify(args)],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000});return t.trim()?JSON.parse(t):null;}catch{throw Error('Local function refused: '+path);}};
 const start=async()=>{log='';backend=spawn(process.execPath,[cli,'dev','--local-cloud-port',String(PORTS.cloud),'--local-site-port',String(PORTS.site),'--typecheck','enable','--tail-logs','disable'],{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
  for(const s of [backend.stdout,backend.stderr])s.on('data',b=>log+=b);
  const end=Date.now()+180_000;while(!log.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>end)throw Error('Local backend not ready; private log retained');await sleep(150);}};
 const stop=async()=>{if(!backend)return;const b=backend;backend=null;const closed=new Promise(r=>b.once('close',r));try{process.kill(-b.pid,'SIGTERM');}catch{}await closed;};

 const secret='whsec_'+randomBytes(24).toString('hex'),wrong='whsec_'+randomBytes(24).toString('hex'),ingressToken=randomUUID();
 const report={level:'SERVICE/SIM builder run: local Convex backend, loopback HTTP receiver, synthetic signing secret, in-process provider-state stub, production-style error redaction on the client. No Stripe API calls, no sandbox writes.',mode,mutant,ports:PORTS,startedAt:new Date().toISOString(),deliveries:[],drains:[],cases:[]};
 let server,client,crashNext=false;
 try{
  await start();
  const connect=()=>{client=new ConvexHttpClient('http://127.0.0.1:'+PORTS.cloud,{logger:false});};connect();
  const m=(n,a)=>client.mutation(api.payments[n],a),q=(n,a)=>client.query(api.payments[n],a);
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
  run('callbackIngestion:configureIngress',{tokenHash:createHash('sha256').update(ingressToken).digest('hex')});
  const accounts={A:'acct_simCallbackA',B:'acct_simCallbackB'};
  for(const n of ['A','B']){run('payments:configureFixture',{binding:f[n].binding,adapterToken:f[n].adapter,account:accounts[n],environment:'SIM',healthy:true});f[n].key={provider:'stripe',environment:'SIM',account:accounts[n]};}
  const docs={};
  const mkDoc=async(n,ext)=>{const customer=run('paymentFixture:customer',{org:f[n].org,binding:f[n].binding,name:'Callback '+n+ext});const id=await m('prepareInvoice',{token:f[n].sessions.owner,customer,amountMinor:100,currency:'usd',kind:'invoice'});await m('attachProvider',{token:f[n].adapter,id,externalId:ext});return id;};
  docs.A=await mkDoc('A','in_simCallbackA');docs.B=await mkDoc('B','in_simCallbackB');docs.gone=await mkDoc('A','in_simGone');docs.flaky=await mkDoc('A','in_simFlaky');
  const merchants=['A','B'].map(n=>({name:n,account:accounts[n],binding:f[n].binding,token:f[n].adapter}));

  // Provider-state stub: every object lives inside one connected account; reads name the account.
  // Missing objects and outages fail the way the real client (stripe.mjs) fails: StripeFailure with a status.
  const provider={[accounts.A]:{},[accounts.B]:{}};
  const invoice=(id,paid)=>({id,object:'invoice',livemode:false,status:paid?'paid':'open',currency:'usd',total:100,amount_due:100,amount_paid:paid?100:0,amount_remaining:paid?0:100,starting_balance:0,amount_overpaid:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0});
  for(const n of ['A','B'])provider[accounts[n]]['/v1/invoices/in_simCallback'+n]=invoice('in_simCallback'+n,false);
  const payA=()=>{const a=provider[accounts.A];a['/v1/invoices/in_simCallbackA']=invoice('in_simCallbackA',true);
   a['/v1/invoice_payments/inpay_simA']={id:'inpay_simA',invoice:'in_simCallbackA',currency:'usd',livemode:false,status:'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:'pi_simA'}};
   a['/v1/payment_intents/pi_simA']={id:'pi_simA',livemode:false,currency:'usd',status:'succeeded',amount_received:100,latest_charge:'ch_simA',metadata:{}};
   a['/v1/charges/ch_simA']={id:'ch_simA',payment_intent:'pi_simA',livemode:false,currency:'usd',amount:100,amount_refunded:0};};
  const providerReads=[];
  const stripe={request:async(method,path,params={},account)=>{
   assert.equal(method,'GET','Provider stub is read-only');providerReads.push({account,path});
   if(path==='/v1/invoices/in_simFlaky')throw new StripeFailure(503,{type:'api_error'},'req_simFlaky');
   const state=provider[account];if(!state)throw new StripeFailure(404,{type:'invalid_request_error',code:'resource_missing',param:'id'},'req_sim');
   const list=p=>({data:Object.entries(state).filter(([k,v])=>k.startsWith(p+'/')&&Object.entries(params).every(([pk,pv])=>pk==='limit'||pk==='starting_after'||v[pk]===pv)).map(([,v])=>v),has_more:false});
   if(['/v1/invoice_payments','/v1/refunds','/v1/credit_notes'].includes(path))return list(path);
   if(!state[path])throw new StripeFailure(404,{type:'invalid_request_error',code:'resource_missing',param:'id'},'req_sim');return structuredClone(state[path]);}};
  const adapter=trustedAdapter(stripe,client,f);

  const deps=convexDeps({client:()=>client,api,ingressToken});
  const ingestFor=async(merchant,row)=>{await deps.ingest(merchant,row);if(crashNext){crashNext=false;server.closeAllConnections();throw Error('crash after durable receipt');}};
  // Baseline: webhooks.mjs listen() handler body plus the sandbox-replay.mjs routing callback, unchanged in behavior.
  const baselineHandler=async(req,res)=>{
   if(req.method!=='POST'||req.url!=='/stripe'){res.writeHead(404).end();return;}
   try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw new Error('Body too large');chunks.push(chunk)}
    const raw=Buffer.concat(chunks);const event=verifyStripe(raw,req.headers['stripe-signature'],secret);const digest=createHash('sha256').update(raw).digest('hex');
    const merchant=merchants.find(x=>x.account===event.account);
    if(merchant)await ingestFor(merchant,{eventId:event.id,type:event.type,externalId:event.data.object.id,digest});
    res.writeHead(200).end('accepted');
   }catch{if(!res.destroyed)res.writeHead(400).end('refused');}};
  const listen=async()=>{const handler=mode==='baseline'?baselineHandler:createReceiver({verify:verifyStripe,secret,merchants,ingest:ingestFor,park:deps.park});server=createServer(handler);await new Promise((r,j)=>{server.once('error',j);server.listen(PORTS.receiver,'127.0.0.1',r);});};
  const unlisten=async()=>{if(!server)return;server.closeAllConnections();await new Promise(r=>server.close(r));server=null;};
  await listen();

  let ackFailNext=false,clock=Date.now();const BACKOFF=60_000;
  const reconcile=(merchant,item)=>adapter.observe(merchant.name,item.externalId,item.eventId+':pull:'+randomUUID(),randomUUID());
  const ack=async(merchant,item)=>{if(ackFailNext){ackFailNext=false;throw Error('crash before acknowledgement');}await deps.ack(merchant,item);};
  const drainAll=async(label,list=merchants)=>{let outcomes;
   if(mode==='baseline'){outcomes=[];try{for(const merchant of list)for(const row of await q('pendingEvents',{token:merchant.token,binding:merchant.binding})){const item={...row,id:row._id};await reconcile(merchant,item);await ack(merchant,item);outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'applied'});}}catch(error){outcomes.push({result:'stopped',reason:String(error.message).slice(0,200)});}}
   else outcomes=await drain({...deps,merchants:list,reconcile,ack,now:()=>clock,backoffMs:BACKOFF});
   report.drains.push({label,outcomes:outcomes.length>12?{count:outcomes.length,byResult:tally(outcomes.map(o=>o.result+(o.code?':'+o.code:''))),sample:outcomes.slice(-3)}:outcomes});return outcomes;};

  const event=(id,type,account,object,created)=>Buffer.from(JSON.stringify({id,object:'event',api_version:'2025-05-28.basil',created,livemode:false,type,...(account===undefined?{}:{account}),data:{object:{id:object,object:type.split('.')[0]==='customer'?'subscription':type.split('.')[0]}}}));
  const sign=(raw,key=secret,t=Math.floor(Date.now()/1000))=>'t='+t+',v1='+createHmac('sha256',key).update(t+'.').update(raw).digest('hex');
  const deliver=async(label,raw,header,quiet)=>{let status;try{const r=await fetch('http://127.0.0.1:'+PORTS.receiver+'/stripe',{method:'POST',headers:{'Stripe-Signature':header,'Content-Type':'application/json'},body:raw});status=r.status;await r.text();}catch{status='no-response';}if(!quiet)report.deliveries.push({label,status});return status;};

  const rowsOf=async(n,eventId)=>client.query(api.callbackIngestion.receipts,{token:f[n].adapter,binding:f[n].binding,eventId});
  const snap=async()=>{const s={};for(const n of ['A','B']){const events=run('paymentFixture:counts',{org:f[n].org}).events;const d=await q('getDocument',{token:f[n].sessions.owner,id:docs[n]});
   s[n]={receiptCount:(await client.query(api.callbackIngestion.receipts,{token:f[n].adapter,binding:f[n].binding,limit:1000})).length,observed:events.filter(e=>e.kind==='payment.observed').length,refused:events.filter(e=>e.kind.startsWith('payment.callback.refused')).map(e=>e.kind),failed:events.filter(e=>e.kind.startsWith('payment.callback.failed')).length,doc:{state:d.state,paidMinor:d.paidMinor,adjustmentsComplete:d.adjustmentsComplete??null},finance:await q('exportFinance',{token:f[n].sessions.owner})};}
   s.parked=await client.query(api.callbackIngestion.parked,{token:ingressToken});return s;};
  const bBefore=(await snap()).B.finance,bChecks=[];
  const checkB=async(at,s)=>{bChecks.push({at,financeUnchanged:JSON.stringify(s.B.finance)===JSON.stringify(bBefore),observed:s.B.observed});};
  const record=(name,pass,detail)=>{report.cases.push({name,pass,detail});console.log((pass?'PASS ':'FAIL ')+name+' '+JSON.stringify(detail).slice(0,500));};
  const t0=Math.floor(Date.now()/1000);

  // 1. Bad signature, tampered body, stale timestamp: refused before any durable write.
  {const before=await snap();const e=event('evt_simBadSig','invoice.paid',accounts.A,'in_simCallbackA',t0);
   const s1=await deliver('wrong secret',e,sign(e,wrong));
   const good=event('evt_simTamper','invoice.paid',accounts.A,'in_simCallbackA',t0),h=sign(good);
   const s2=await deliver('tampered body',Buffer.from(good.toString().replace('invoice.paid','invoice.voided')),h);
   const s3=await deliver('stale timestamp',good,sign(good,secret,t0-600));
   await drainAll('after bad signatures');const after=await snap();await checkB('bad signature',after);
   const pass=[s1,s2,s3].every(s=>s===400)&&after.A.receiptCount===before.A.receiptCount&&after.B.receiptCount===before.B.receiptCount&&after.A.observed===before.A.observed;
   record('bad signature refused with no durable effect',pass,{statuses:[s1,s2,s3],receiptsA:after.A.receiptCount,receiptsB:after.B.receiptCount});}

  // 2. Crash after the receipt is durable but before acknowledgement and reconciliation; restart; provider redelivers.
  const e1=event('evt_simFinalized','invoice.finalized',accounts.A,'in_simCallbackA',t0+1);
  let replayHeader;
  {const before=await snap();crashNext=true;const s1=await deliver('first delivery, crash after receipt',e1,sign(e1));
   await unlisten();await stop();await start();connect();await listen();
   const survived=await rowsOf('A','evt_simFinalized');
   replayHeader=sign(e1);const s2=await deliver('provider redelivery after restart',e1,replayHeader);
   const outcomes=await drainAll('after restart');const after=await snap();await checkB('crash',after);
   const r=await rowsOf('A','evt_simFinalized');
   const pass=s1==='no-response'&&survived.length===1&&survived[0].done===false&&s2===200&&r.length===1&&r[0].done===true&&after.A.observed-before.A.observed===1&&after.A.doc.state==='open'&&after.A.doc.adjustmentsComplete===true&&(await rowsOf('B','evt_simFinalized')).length===0;
   record('crash between durable receipt and reconciliation, then restart',pass,{firstDelivery:s1,receiptsAfterRestart:survived.length,redelivery:s2,receipts:r.length,observations:after.A.observed-before.A.observed,doc:after.A.doc,outcomes});}

  // 3. Exact replay: same bytes, same signature header.
  {const before=await snap();const s=await deliver('exact replay',e1,replayHeader);const outcomes=await drainAll('after replay');const after=await snap();await checkB('replay',after);
   const r=await rowsOf('A','evt_simFinalized');
   const pass=s===200&&r.length===1&&after.A.receiptCount===before.A.receiptCount&&after.A.observed===before.A.observed;
   record('exact replay produces no second effect',pass,{status:s,receipts:r.length,observations:after.A.observed-before.A.observed,outcomes});}

  // 4. Out of order: the newer paid event is processed first, then an older update arrives late.
  {const before=await snap();payA();
   const paid=event('evt_simPaid','invoice.paid',accounts.A,'in_simCallbackA',t0+3),older=event('evt_simUpdatedEarlier','invoice.updated',accounts.A,'in_simCallbackA',t0+2);
   const s1=await deliver('newer paid event',paid,sign(paid));const o1=await drainAll('after newer event');const mid=await snap();
   const s2=await deliver('older update event, late',older,sign(older));const o2=await drainAll('after older event');const after=await snap();await checkB('out of order',after);
   const rp=await rowsOf('A','evt_simPaid'),ro=await rowsOf('A','evt_simUpdatedEarlier');
   const pass=s1===200&&s2===200&&rp.length===1&&ro.length===1&&rp[0].done&&ro[0].done&&after.A.observed-before.A.observed===2&&mid.A.doc.state==='paid'&&after.A.doc.state==='paid'&&after.A.doc.paidMinor===100&&after.A.doc.adjustmentsComplete===true;
   record('out-of-order events converge to provider state without regression',pass,{statuses:[s1,s2],docAfterNewer:mid.A.doc,docAfterOlder:after.A.doc,observations:after.A.observed-before.A.observed,outcomes:[...o1,...o2]});}

  // 5. Substitution: unbound account is parked with no effect (redelivery parks once); no account is refused;
  //    a valid event naming merchant B for A's invoice is refused on B with a typed code.
  {const before=await snap();
   const c=event('evt_simUnbound','invoice.voided','acct_simCallbackC','in_simCallbackA',t0+4),none=event('evt_simPlatform','invoice.voided',undefined,'in_simCallbackA',t0+4),sub=event('evt_simSubstituted','invoice.voided',accounts.B,'in_simCallbackA',t0+4);
   const sc=await deliver('unbound account',c,sign(c)),sc2=await deliver('unbound account redelivered',c,sign(c)),sn=await deliver('no connected account',none,sign(none)),ss=await deliver('claims merchant B for A object',sub,sign(sub));
   const outcomes=await drainAll('after substitution');const after=await snap();await checkB('substitution',after);
   const nowhere=async id=>(await rowsOf('A',id)).length===0&&(await rowsOf('B',id)).length===0,subB=await rowsOf('B','evt_simSubstituted');
   const parkedC=after.parked.rows.filter(r=>r.account==='acct_simCallbackC'&&r.eventId==='evt_simUnbound'),alertC=after.parked.alerts.find(a=>a.kind==='parked'&&a.account==='acct_simCallbackC');
   const newRefusedB=after.B.refused.slice(before.B.refused.length);
   const pass=sc===200&&sc2===200&&parkedC.length===1&&alertC?.count===1&&sn===400&&await nowhere('evt_simUnbound')&&await nowhere('evt_simPlatform')&&ss===200&&(await rowsOf('A','evt_simSubstituted')).length===0&&subB.length===1&&subB[0].done===true&&newRefusedB.length===1&&newRefusedB[0]==='payment.callback.refused:unbound_document'&&after.B.observed===0&&after.A.observed===before.A.observed&&JSON.stringify(after.A.doc)===JSON.stringify(before.A.doc);
   record('unbound account parked, no account refused, substituted account refused on the claimed merchant with a typed code',pass,{statuses:{unbound:sc,unboundRedelivered:sc2,noAccount:sn,claimsB:ss},parkedC:parkedC.length,alertC,receiptsUnderB:subB,refusedOnB:newRefusedB,docA:after.A.doc,outcomes});}

  // 6. Non-invoice event types are refused explicitly with a recorded reason, never silently closed.
  {const before=await snap();const types=['charge.refunded','charge.dispute.created','credit_note.created','customer.subscription.updated'],objects=['ch_simA','dp_simA','cn_simA','sub_simA'];
   const statuses=[];for(const [i,type] of types.entries()){const e=event('evt_simType'+i,type,accounts.A,objects[i],t0+5);statuses.push(await deliver(type,e,sign(e)));}
   const outcomes=await drainAll('after non-invoice types');const after=await snap();await checkB('non-invoice types',after);
   const newRefused=after.A.refused.slice(before.A.refused.length),closed=await Promise.all(types.map((_,i)=>rowsOf('A','evt_simType'+i)));
   const pass=statuses.every(s=>s===200)&&newRefused.length===4&&newRefused.every(k=>k==='payment.callback.refused:unsupported_event_type')&&closed.every(r=>r.length===1&&r[0].done)&&after.A.observed===before.A.observed;
   record('refund, dispute, credit note and subscription events refused with reason unsupported_event_type',pass,{statuses,refused:newRefused,outcomes});}

  // 7. A merchant whose adapter access fails does not stop the others.
  {const e=event('evt_simIsolated','invoice.updated',accounts.A,'in_simCallbackA',t0+6);const s=await deliver('A event behind revoked merchant',e,sign(e));
   let threw=null,outcomes=null;try{outcomes=await drainAll('revoked merchant first',[{...merchants[1],token:'revoked-'+randomUUID()},merchants[0]]);}catch(error){threw=String(error.message).slice(0,120);}
   const after=await snap();await checkB('isolation',after);const r=await rowsOf('A','evt_simIsolated');
   record('failing merchant is isolated; later merchants still drain',s===200&&threw===null&&r[0]?.done===true&&outcomes?.[0]?.result!=='applied',{status:s,threw,outcomes,receiptDone:r[0]?.done});}

  // 8. A real-client 404 (StripeFailure resource_missing) is final: closed as refused with a typed code.
  {const before=await snap();const e=event('evt_simGone','invoice.updated',accounts.A,'in_simGone',t0+7);await deliver('bound invoice missing at provider',e,sign(e));
   const outcomes=await drainAll('after provider 404');const after=await snap();await checkB('provider 404',after);
   const newRefused=after.A.refused.slice(before.A.refused.length),r=await rowsOf('A','evt_simGone');
   record('provider 404 closes the receipt as refused, decided by error type',newRefused.length===1&&newRefused[0]==='payment.callback.refused:provider_404_resource_missing'&&r[0]?.done===true,{refused:newRefused,outcomes,receiptDone:r[0]?.done});}

  // 9. Liveness and bounded retries: 100 receipts that keep failing with a retryable 503 wait out their backoff,
  //    a newer valid receipt still drains, and after 5 attempts each stuck receipt closes as failed with an audit row.
  {const before=await snap();const statuses=[];for(let i=0;i<100;i++){const e=event('evt_simFlaky'+i,'invoice.updated',accounts.A,'in_simFlaky',t0+8);statuses.push(await deliver('flaky '+i,e,sign(e),true));}
   report.deliveries.push({label:'100 flaky deliveries',status:tally(statuses)});
   const o1=await drainAll('flaky first attempt');
   const e=event('evt_simAfterFlaky','invoice.updated',accounts.A,'in_simCallbackA',t0+9);await deliver('valid receipt behind 100 stuck',e,sign(e));
   const o2=await drainAll('same clock: stuck receipts not due');const valid=(await rowsOf('A','evt_simAfterFlaky'))[0];
   let queryOk=true;try{const newest=await client.query(api.callbackIngestion.receipts,{token:f.A.adapter,binding:f.A.binding});queryOk=newest.length===100&&newest[0].eventId==='evt_simAfterFlaky';}catch{queryOk=false;}
   const later=[];for(let i=0;i<6;i++){clock+=BACKOFF*2**6;later.push(tally((await drainAll('clock advanced '+(i+1))).map(o=>o.result)));}
   const after=await snap();await checkB('liveness',after);const flakyOpen=(await Promise.all(Array.from({length:100},(_,i)=>rowsOf('A','evt_simFlaky'+i)))).filter(r=>!r[0]?.done).length;
   const pass=statuses.every(s=>s===200)&&o1.filter(o=>o.result==='retry').length===100&&valid?.done===true&&o2.filter(o=>o.eventId?.startsWith('evt_simFlaky')).length===0&&queryOk&&after.A.failed-before.A.failed===100&&flakyOpen===0;
   record('stuck receipts back off, do not starve newer ones, and close as failed after bounded attempts',pass,{firstDrain:tally(o1.map(o=>o.result)),validReceiptDone:valid?.done,flakyTouchedAtSameClock:o2.filter(o=>o.eventId?.startsWith('evt_simFlaky')).length,receiptsQueryAbove100:queryOk,laterDrains:later,failedAuditRows:after.A.failed-before.A.failed,stillOpen:flakyOpen});}

  // Extra probe (not a required case): crash after the ledger write but before acknowledgement.
  {const before=await snap();const e=event('evt_simUpdatedLate','invoice.updated',accounts.A,'in_simCallbackA',t0+10);const s=await deliver('update event',e,sign(e));
   ackFailNext=true;const o1=await drainAll('ack lost');await stop();await start();connect();const o2=await drainAll('after restart');const after=await snap();await checkB('ack-loss probe',after);
   const r=await rowsOf('A','evt_simUpdatedLate');
   report.probe={name:'crash after ledger write, before acknowledgement',status:s,receipts:r.length,done:r[0]?.done,observationsWritten:after.A.observed-before.A.observed,docBefore:before.A.doc,docAfter:after.A.doc,outcomes:[...o1,...o2]};
   console.log('PROBE '+JSON.stringify(report.probe));}

  record('tenant B financial state unchanged throughout',bChecks.every(c=>c.financeUnchanged&&c.observed===0),{checkpoints:bChecks});
  report.providerReads={total:providerReads.length,byAccount:Object.fromEntries(Object.values(accounts).map(a=>[a,providerReads.filter(r=>r.account===a).length]))};
 }finally{
  await new Promise(r=>server?server.close(r):r());await stop();writeFileSync(cwd+'/backend.log',log,{mode:0o600});
 }
 report.finishedAt=new Date().toISOString();
 writeFileSync(out+label(mode,mutant)+'.json',JSON.stringify(report,null,1)+'\n');
 process.exit(report.cases.every(c=>c.pass)?0:1);
}
function tally(values){return values.reduce((a,v)=>(a[v]=(a[v]??0)+1,a),{});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function inUse(port){return new Promise(r=>{const s=createConnection({port,host:'127.0.0.1'});s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});}
