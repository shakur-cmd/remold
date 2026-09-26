// Independent verifier attacks for P4 callback ingestion. SERVICE/SIM only: local Convex on 3730/3731,
// loopback receiver on 3732, synthetic secret, in-process provider stub. No Stripe calls.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,cpSync,readFileSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {trustedAdapter} from './adapter.mjs';
import {StripeFailure,OutcomeUnknown} from './stripe.mjs';
import {ConvexError} from 'convex/values';
import {renameSync} from 'node:fs';

const here=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../',import.meta.url));
const out=here+'evidence/callback-ingestion/fix2/'+(process.env.IV_OUT??'r2-before')+'/';
const REDACT=process.env.IV_REDACT==='1';if(REDACT)await import('./callback/redact-hook.mjs');
const PORTS={cloud:3750,site:3751,receiver:3752,receiver2:3753};
const mutant=process.argv.find(a=>a.startsWith('--mutant='))?.split('=')[1]??'none';

// Verifier-authored mutants. Each anchor must match exactly once in the private copy.
const MUTANTS={
 'ack-before-store':{file:'callback-ingestion.mjs',from:"   if(merchant)await ingest(merchant,row);else await park(event.account,row);\n   res.writeHead(200).end('accepted');",to:"   res.writeHead(200).end('accepted');\n   if(merchant)await ingest(merchant,row);else await park(event.account,row);"},
 'ack-on-error':{file:'callback-ingestion.mjs',from:"else{const r=await defer(merchant,item,failure.code,now(),backoffMs);",to:"else{await ack(merchant,item);const r={state:'retry',attempts:0};"},
 'final-everything':{file:'callback-ingestion.mjs',from:" return{final:false,code:codeOf(error)};\n}",to:" return{final:true,code:codeOf(error)};\n}"},
 'header-binding':{file:'callback-ingestion.mjs',from:"merchants.find(m=>m.account===event.account)",to:"merchants.find(m=>m.account===(req.headers['stripe-account']??event.account))"},
 'refuse-scope':{file:'convex/callbackIngestion.ts',from:"    const { row, binding } = await receipt(ctx, a.token, a.id);\n    if (!CODE.test(a.reason)) fail('invalid_code');",to:"    const row = (await ctx.db.get(a.id))!, binding = (await ctx.db.get(row.binding))!;\n    if (!CODE.test(a.reason)) fail('invalid_code');"},
 'digest-compare':{file:'convex/payments.ts',from:"            if (old.digest !== a.digest)\n                deny('event integrity mismatch');\n            return false;\n        }\n        const { token, ...row } = a;",to:"            return false;\n        }\n        const { token, ...row } = a;"},
 'merchant-isolation':{file:'callback-ingestion.mjs',from:"try{items=await due(merchant,now());}catch(error){outcomes.push({merchant:merchant.name,result:'merchant_error',code:codeOf(error)});continue;}",to:"items=await due(merchant,now());"},
 'item-isolation':{file:'callback-ingestion.mjs',from:"}catch(error){outcomes.push({...base,result:'item_error',code:codeOf(error)});}",to:"}catch(error){throw error;}"},
 '404-retryable':{file:'callback-ingestion.mjs',from:"![408,409,429].includes(status)",to:"![404,408,409,429].includes(status)"},
 'backoff-skip':{file:'convex/callbackIngestion.ts',from:"        if (retry && retry.nextAt > a.now) continue;\n",to:""},
 'attempt-cap':{file:'convex/callbackIngestion.ts',from:"const MAX_ATTEMPTS = 5,",to:"const MAX_ATTEMPTS = 1e9,"},
 'typed-refusal':{file:'convex/callbackIngestion.ts',from:"    if (!doc) return { action: 'refuse' as const, code: 'unbound_document' };\n",to:""},
 'unsupported':{file:'convex/callbackIngestion.ts',from:"    if (!row.type.startsWith('invoice.')) return { action: 'refuse' as const, code: 'unsupported_event_type' };\n",to:""},
 'park-dedupe':{file:'convex/callbackIngestion.ts',from:"    if (await ctx.db.query('callbackParked').withIndex('key', q => q.eq('account', a.account).eq('eventId', a.eventId)).unique()) return { parked: false, duplicate: true };\n",to:""},
 'park-cap':{file:'convex/callbackIngestion.ts',from:"    if ((await ctx.db.query('callbackParked').take(PARK_CAP)).length >= PARK_CAP) { await alert(ctx, 'park_overflow', a.account, a.eventId); return { parked: false, duplicate: false }; }\n",to:""},
 'park-bound':{file:'convex/callbackIngestion.ts',from:"        if (await ctx.db.query('bindings').withIndex('key', q => q.eq('provider', 'stripe').eq('environment', environment).eq('account', a.account)).first()) fail('account_bound');",to:"        ;"},
 'ingress-auth':{file:'convex/callbackIngestion.ts',from:"    await ingress(ctx, a.token);\n    if (!ACCOUNT.test(a.account))",to:"    if (!ACCOUNT.test(a.account))"},
 'park-alert':{file:'convex/callbackIngestion.ts',from:"    await alert(ctx, 'parked', a.account, a.eventId);\n",to:""},
};

const report={level:'SERVICE/SIM independent verifier run; no Stripe calls, no sandbox writes',mutant,ports:PORTS,startedAt:new Date().toISOString(),attacks:[]};
for(const port of Object.values(PORTS))assert.equal(await inUse(port),false,'Port busy: '+port);
mkdirSync(here+'private',{recursive:true,mode:0o700});mkdirSync(out,{recursive:true});
const cwd=mkdtempSync(here+'private/iv-r2-'+mutant+'-');
cpSync(here+'convex',cwd+'/convex',{recursive:true});
renameSync(cwd+'/convex/schema.ts',cwd+'/convex/payment_schema.ts');for(const n of ['schema.ts','callbackIngestion.ts'])cpSync(here+'callback/'+n,cwd+'/convex/'+n);
for(const name of ['tsconfig.json','package.json','webhooks.mjs','callback-ingestion.mjs'])cpSync(here+name,cwd+'/'+name);
writeFileSync(cwd+'/convex.json','{"functions":"convex"}');symlinkSync(root+'node_modules',cwd+'/node_modules','dir');
if(mutant!=='none'){const m=MUTANTS[mutant];assert.ok(m,'unknown mutant');const path=cwd+'/'+m.file,text=readFileSync(path,'utf8');assert.equal(text.split(m.from).length,2,'anchor must match once: '+mutant);writeFileSync(path,text.replace(m.from,m.to));}
const {verifyStripe}=await import(pathToFileURL(cwd+'/webhooks.mjs'));
const {createReceiver,drain,convexDeps,classify}=await import(pathToFileURL(cwd+'/callback-ingestion.mjs'));

const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1',CI:'1'};
const cli=root+'node_modules/convex/bin/main.js';let backend,log='';
const run=(path,args={})=>{const t=execFileSync(process.execPath,[cli,'run',path,JSON.stringify(args)],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000});return t.trim()?JSON.parse(t):null;};
const start=async()=>{log='';backend=spawn(process.execPath,[cli,'dev','--local-cloud-port',String(PORTS.cloud),'--local-site-port',String(PORTS.site),'--typecheck','enable','--tail-logs','disable'],{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
 for(const s of [backend.stdout,backend.stderr])s.on('data',b=>log+=b);
 const end=Date.now()+180_000;while(!log.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>end)throw Error('backend not ready');await sleep(150);}};
const stop=async()=>{if(!backend)return;const b=backend;backend=null;const closed=new Promise(r=>b.once('close',r));try{process.kill(-b.pid,'SIGTERM');}catch{}await closed;};

const secret='whsec_'+randomBytes(24).toString('hex');
let server,client;
const record=(name,pass,detail)=>{report.attacks.push({name,pass,detail});console.log((pass?'PASS ':'FAIL ')+name+' '+JSON.stringify(detail).slice(0,400));};
try{
 await start();
 const connect=()=>{client=new ConvexHttpClient('http://127.0.0.1:'+PORTS.cloud,{logger:false});};connect();
 const m=(n,a)=>client.mutation(api.payments[n],a),q=(n,a)=>client.query(api.payments[n],a);
 const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 const ingressToken=randomUUID();run('callbackIngestion:configureIngress',{tokenHash:createHash('sha256').update(ingressToken).digest('hex')});const deps=convexDeps({client:()=>client,api,ingressToken});
 const accounts={A:'acct_ivA',B:'acct_ivB'};
 for(const n of ['A','B']){run('payments:configureFixture',{binding:f[n].binding,adapterToken:f[n].adapter,account:accounts[n],environment:'SIM',healthy:true});f[n].key={provider:'stripe',environment:'SIM',account:accounts[n]};}
 const docs={};
 const mkDoc=async(n,ext)=>{const customer=run('paymentFixture:customer',{org:f[n].org,binding:f[n].binding,name:'IV '+n+ext});const id=await m('prepareInvoice',{token:f[n].sessions.owner,customer,amountMinor:100,currency:'usd',kind:'invoice'});await m('attachProvider',{token:f[n].adapter,id,externalId:ext});return id;};
 docs.A=await mkDoc('A','in_ivA');docs.B=await mkDoc('B','in_ivB');docs.Agone=await mkDoc('A','in_ivGone');for(const x of ['in_r2Auth','in_r2Rate','in_r2Flaky','in_r2Flood'])await mkDoc('A',x);
 const merchants=['A','B'].map(n=>({name:n,account:accounts[n],binding:f[n].binding,token:f[n].adapter}));

 const provider={[accounts.A]:{},[accounts.B]:{}};
 const invoice=(id,paid)=>({id,object:'invoice',livemode:false,status:paid?'paid':'open',currency:'usd',total:100,amount_due:100,amount_paid:paid?100:0,amount_remaining:paid?0:100,starting_balance:0,amount_overpaid:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0});
 provider[accounts.A]['/v1/invoices/in_ivA']=invoice('in_ivA',false);provider[accounts.B]['/v1/invoices/in_ivB']=invoice('in_ivB',false);
 const providerReads=[],failPath={};let transientOnce=0;
 const stripe={request:async(method,path,params={},account)=>{
  assert.equal(method,'GET');providerReads.push({account,path});
  if(transientOnce>0){transientOnce--;throw Error('fetch failed ECONNRESET');}
  if(failPath[path])throw failPath[path]();
  const state=provider[account];if(!state)throw Error('No such object: account');
  const list=p=>({data:Object.entries(state).filter(([k,v])=>k.startsWith(p+'/')&&Object.entries(params).every(([pk,pv])=>pk==='limit'||pk==='starting_after'||v[pk]===pv)).map(([,v])=>v),has_more:false});
  if(['/v1/invoice_payments','/v1/refunds','/v1/credit_notes'].includes(path))return list(path);
  // Real provider errors come through stripe.mjs as StripeFailure, not the replay stub's "No such object" text.
  if(!state[path])throw new StripeFailure(404,{type:'invalid_request_error',code:'resource_missing',param:'id'},'req_sim');
  return structuredClone(state[path]);}};
 const adapter=trustedAdapter(stripe,client,f);
 const ingestFor=(merchant,row)=>m('ingest',{token:merchant.token,binding:merchant.binding,...row});
 const listen=async()=>{server=createServer(createReceiver({verify:verifyStripe,secret,merchants,ingest:ingestFor,park:deps.park}));await new Promise((r,j)=>{server.once('error',j);server.listen(PORTS.receiver,'127.0.0.1',r);});};
 await listen();
 let ackFailNext=false;
 const reconcile=(merchant,row)=>adapter.observe(merchant.name,row.externalId,row.eventId+':pull:'+randomUUID(),randomUUID());
 const ack=async(merchant,row)=>{if(ackFailNext){ackFailNext=false;throw Error('crash before acknowledgement');}await m('ackEvent',{token:merchant.token,id:row.id??row._id});};
 const pending=merchant=>q('pendingEvents',{token:merchant.token,binding:merchant.binding});
 const refuse=(merchant,row,reason)=>client.mutation(api.callbackIngestion.refuse,{token:merchant.token,id:row._id,reason});
 const drainAll=(list=merchants)=>drain({...deps,merchants:list,reconcile,ack,backoffMs:0});

 const t=()=>Math.floor(Date.now()/1000);
 const event=(id,type,account,object,extra={})=>Buffer.from(JSON.stringify({id,object:'event',api_version:'2025-05-28.basil',created:t(),livemode:false,type,...(account===undefined?{}:{account}),data:{object:{id:object,object:'invoice'}},...extra}));
 const sign=(raw,ts=t(),key=secret)=>'t='+ts+',v1='+createHmac('sha256',key).update(ts+'.').update(raw).digest('hex');
 const deliver=async(raw,header,headers={})=>{try{const r=await fetch('http://127.0.0.1:'+PORTS.receiver+'/stripe',{method:'POST',headers:{'Stripe-Signature':header,'Content-Type':'application/json',...headers},body:raw});await r.text();return r.status;}catch{return 'no-response';}};
 const snap=async()=>{const s={};for(const n of ['A','B']){const events=run('paymentFixture:counts',{org:f[n].org}).events;
  let receipts;try{receipts=await client.query(api.callbackIngestion.receipts,{token:f[n].adapter,binding:f[n].binding});}catch{receipts=null;}
  s[n]={receipts,observed:events.filter(e=>e.kind==='payment.observed').length,refused:events.filter(e=>e.kind.startsWith('payment.callback.refused')).length,events:events.length,finance:await q('exportFinance',{token:f[n].sessions.owner})};}return s;};
 const rows=(s,n,id)=>(s[n].receipts??dataRows(n)).filter(r=>r.eventId===id);
 const dataRows=n=>execFileSync(process.execPath,[cli,'data','payIncoming','--limit','10000','--format','jsonLines'],{cwd,env,encoding:'utf8'}).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.binding===f[n].binding);
 const docOf=(s,n,id)=>s[n].finance.documents.find(d=>d._id===id);
 const b0=(await snap()).B.finance;const bSame=async()=>JSON.stringify((await snap()).B.finance)===JSON.stringify(b0);

 // 1. Same event id, different body (both validly signed).
 {const e1=event('evt_ivSame','invoice.finalized',accounts.A,'in_ivA'),e2=event('evt_ivSame','invoice.voided',accounts.A,'in_ivA');
  const s1=await deliver(e1,sign(e1)),s2=await deliver(e2,sign(e2));const s=await snap();const r=rows(s,'A','evt_ivSame');
  record('same event id with a different body is refused after the first',s1===200&&s2===400&&r.length===1&&r[0].digest===createHash('sha256').update(e1).digest('hex'),{s1,s2,receipts:r.length,keptFirstDigest:r[0]?.digest===createHash('sha256').update(e1).digest('hex')});
  await drainAll();}

 // 2. Payload names A, transport header claims B: the header must not pick the tenant.
 {const e=event('evt_ivHeader','invoice.finalized',accounts.A,'in_ivA');const s1=await deliver(e,sign(e),{'Stripe-Account':accounts.B});const s=await snap();
  record('Stripe-Account header does not override payload account',s1===200&&rows(s,'A','evt_ivHeader').length===1&&rows(s,'B','evt_ivHeader').length===0,{status:s1,underA:rows(s,'A','evt_ivHeader').length,underB:rows(s,'B','evt_ivHeader').length});
  await drainAll();}

 // 3. Replay after acknowledgement, re-signed with a fresh timestamp.
 {const e=event('evt_ivAcked','invoice.finalized',accounts.A,'in_ivA');await deliver(e,sign(e));const o1=await drainAll();const before=await snap();
  const s1=await deliver(e,sign(e,t()+1));const o2=await drainAll();const after=await snap();const r=rows(after,'A','evt_ivAcked');
  record('replay after acknowledgement has no second effect',s1===200&&r.length===1&&r[0].done===true&&o2.length===0&&after.A.observed===before.A.observed,{status:s1,receipts:r.length,done:r[0]?.done,secondDrain:o2,observedDelta:after.A.observed-before.A.observed,firstDrain:o1});}

 // 4. Concurrent duplicate delivery: 25 parallel POSTs of identical bytes, plus 10 parallel same-id different bodies.
 {const e=event('evt_ivParallel','invoice.finalized',accounts.A,'in_ivA'),h=sign(e);const before=await snap();
  const statuses=await Promise.all(Array.from({length:25},()=>deliver(e,h)));
  const variants=Array.from({length:10},(_,i)=>event('evt_ivRace','invoice.finalized',accounts.A,'in_ivA',{request:{id:'req_'+i}}));
  const vstat=await Promise.all(variants.map(v=>deliver(v,sign(v))));
  const o=await drainAll();const after=await snap();
  record('parallel duplicate deliveries store one receipt and one effect',statuses.every(s=>s===200)&&rows(after,'A','evt_ivParallel').length===1&&rows(after,'A','evt_ivRace').length===1&&vstat.filter(s=>s===200).length===1&&vstat.filter(s=>s===400).length===9&&after.A.observed-before.A.observed===2,{identical:statuses.reduce((a,s)=>(a[s]=(a[s]??0)+1,a),{}),variants:vstat,receiptsParallel:rows(after,'A','evt_ivParallel').length,receiptsRace:rows(after,'A','evt_ivRace').length,observedDelta:after.A.observed-before.A.observed,drain:o});}

 // 5. Crash after ledger write, before ack (builder-disclosed duplicate audit row): is it harmless?
 {provider[accounts.A]['/v1/invoices/in_ivA']=invoice('in_ivA',true);
  const a=provider[accounts.A];a['/v1/invoice_payments/inpay_ivA']={id:'inpay_ivA',invoice:'in_ivA',currency:'usd',livemode:false,status:'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:'pi_ivA'}};
  a['/v1/payment_intents/pi_ivA']={id:'pi_ivA',livemode:false,currency:'usd',status:'succeeded',amount_received:100,latest_charge:'ch_ivA',metadata:{}};a['/v1/charges/ch_ivA']={id:'ch_ivA',payment_intent:'pi_ivA',livemode:false,currency:'usd',amount:100,amount_refunded:0};
  const e=event('evt_ivPaid','invoice.paid',accounts.A,'in_ivA');await deliver(e,sign(e));
  // Reference: a clean single drain of an identical paid state.
  ackFailNext=true;const o1=await drainAll();const mid=await snap();await stop();await start();connect();const o2=await drainAll();const after=await snap();
  const strip=d=>{const {adjustmentEpoch,_creationTime,...rest}=d;return rest;};
  const e2=event('evt_ivPaidClean','invoice.updated',accounts.A,'in_ivA');await deliver(e2,sign(e2));await drainAll();const clean=await snap();
  const dAfter=docOf(after,'A',docs.A),dClean=docOf(clean,'A',docs.A);
  record('ack loss after ledger write: financial state equals a clean drain; only audit rows differ',JSON.stringify(strip(dAfter))===JSON.stringify(strip(dClean))&&dAfter.state==='paid'&&dAfter.paidMinor===100&&dAfter.adjustmentsComplete===true&&rows(after,'A','evt_ivPaid')[0].done===true&&after.A.observed-mid.A.observed===1,{docAfterAckLoss:strip(dAfter),docAfterCleanUpdate:strip(dClean),epochs:[dAfter.adjustmentEpoch,dClean.adjustmentEpoch],observedMidToAfter:after.A.observed-mid.A.observed,outcomes:[...o1,...o2]});}

 // 6. Event for bound account A naming B's invoice.
 {const readsBefore=providerReads.length;const bBefore=await snap();const e=event('evt_ivCross','invoice.voided',accounts.A,'in_ivB');const s1=await deliver(e,sign(e));const o=await drainAll();const after=await snap();
  const newReads=providerReads.slice(readsBefore);
  record('A-signed event naming B invoice is refused and closed, B untouched, B account never read',s1===200&&rows(after,'A','evt_ivCross')[0]?.done===true&&after.A.refused-bBefore.A.refused===1&&rows(after,'B','evt_ivCross').length===0&&await bSame()&&newReads.every(r=>r.account!==accounts.B),{status:s1,outcomes:o,refusedOnA:after.A.refused-bBefore.A.refused,newReads});}

 // 7. Oversized and malformed bodies.
 {const before=await snap();
  const big=Buffer.from(JSON.stringify({id:'evt_ivBig',object:'event',livemode:false,type:'invoice.paid',account:accounts.A,data:{object:{id:'in_ivA',pad:'x'.repeat(1_100_000)}}}));
  const cases={oversized:big,notJson:Buffer.from('{"id":"evt_ivBad",'),nullBody:Buffer.from('null'),arrayBody:Buffer.from('[]'),numericObjectId:event('evt_ivNum','invoice.paid',accounts.A,12345),missingId:Buffer.from(JSON.stringify({object:'event',livemode:false,type:'invoice.paid',account:accounts.A,data:{object:{id:'in_ivA'}}})),liveMode:Buffer.from(JSON.stringify({id:'evt_ivLive',object:'event',livemode:true,type:'invoice.paid',account:accounts.A,data:{object:{id:'in_ivA'}}})),arrayAccount:event('evt_ivArr','invoice.paid',[accounts.A],'in_ivA'),paddedAccount:event('evt_ivPad','invoice.paid',accounts.A+' ','in_ivA'),protoAccount:event('evt_ivProto','invoice.paid','__proto__','in_ivA')};
  const st={};for(const [k,raw] of Object.entries(cases))st[k]=await deliver(raw,sign(raw));
  const after=await snap();
  record('oversized, malformed and type-confused bodies refused with no receipt',Object.values(st).every(s=>s===400)&&after.A.receipts.length===before.A.receipts.length&&after.B.receipts.length===before.B.receipts.length,{statuses:st,receiptDelta:after.A.receipts.length-before.A.receipts.length});}

 // 8. Signature timestamp edges and header shapes.
 {const mk=id=>event(id,'invoice.finalized',accounts.A,'in_ivA');const now=t();
  const r={};const e1=mk('evt_ivT1'),e2=mk('evt_ivT2'),e3=mk('evt_ivT3'),e4=mk('evt_ivT4'),e5=mk('evt_ivT5'),e6=mk('evt_ivT6'),e7=mk('evt_ivT7'),e8=mk('evt_ivT8');
  r.past295=await deliver(e1,sign(e1,now-295));r.past305=await deliver(e2,sign(e2,now-305));r.future295=await deliver(e3,sign(e3,now+295));r.future305=await deliver(e4,sign(e4,now+305));
  const good=sign(e5);r.twoV1OneGood='t='+good.split(',')[0].slice(2)+',v1='+'0'.repeat(64)+','+good.split(',')[1];r.twoV1OneGood=await deliver(e5,r.twoV1OneGood);
  r.v0Only=await deliver(e6,sign(e6).replace('v1=','v0='));r.noHeader=await deliver(e7,'');
  const ts=now;r.signedWithoutTimestampPrefix=await deliver(e8,'t='+ts+',v1='+createHmac('sha256',secret).update(e8).digest('hex'));
  const s=await snap();const got=id=>rows(s,'A',id).length;
  const pass=r.past295===200&&r.past305===400&&r.future295===200&&r.future305===400&&r.twoV1OneGood===200&&r.v0Only===400&&r.noHeader===400&&r.signedWithoutTimestampPrefix===400&&got('evt_ivT2')+got('evt_ivT4')+got('evt_ivT6')+got('evt_ivT7')+got('evt_ivT8')===0;
  record('signature timestamp window is 300s both directions; header shape edges',pass,r);await drainAll();}

 // 9. Durable store unavailable: the receiver must not acknowledge.
 {await stop();const e=event('evt_ivDown','invoice.finalized',accounts.A,'in_ivA');const s1=await deliver(e,sign(e));await start();connect();const s=await snap();
  const s2=await deliver(e,sign(e));const s3=await snap();
  record('backend down: receiver returns non-2xx and stores nothing; redelivery after recovery stores once',s1===400&&rows(s,'A','evt_ivDown').length===0&&s2===200&&rows(s3,'A','evt_ivDown').length===1,{whileDown:s1,afterRecovery:s2,receiptsAfter:rows(s3,'A','evt_ivDown').length});await drainAll();}

 // 10. Transient provider failure stays pending and applies once on the next drain.
 {const before=await snap();const e=event('evt_ivTransient','invoice.updated',accounts.A,'in_ivA');await deliver(e,sign(e));transientOnce=1;const o1=await drainAll();const mid=await snap();const o2=await drainAll();const after=await snap();
  record('transient provider failure is retried, not refused or acknowledged',o1.find(x=>x.eventId==='evt_ivTransient')?.result==='retry'&&rows(mid,'A','evt_ivTransient')[0].done===false&&o2.find(x=>x.eventId==='evt_ivTransient')?.result==='applied'&&after.A.refused===before.A.refused&&after.A.observed-before.A.observed===1,{first:o1,second:o2});}

 // 11. Cross-tenant use of the new Convex functions: B's adapter token against A's receipts.
 {const e=event('evt_ivCrossRefuse','invoice.finalized',accounts.A,'in_ivA');await deliver(e,sign(e));const row=(await pending(merchants[0])).find(r=>r.eventId==='evt_ivCrossRefuse');
  let refuseErr=null,readErr=null;try{await client.mutation(api.callbackIngestion.refuse,{token:f.B.adapter,id:row._id,reason:'x'});}catch(err){refuseErr=String(err.message).slice(0,120);}
  try{await client.query(api.callbackIngestion.receipts,{token:f.B.adapter,binding:f.A.binding});}catch(err){readErr=String(err.message).slice(0,120);}
  const stillPending=(await pending(merchants[0])).some(r=>r.eventId==='evt_ivCrossRefuse');
  record('B adapter token cannot refuse or list A receipts',!!refuseErr&&!!readErr&&stillPending,{refuseErr,readErr,stillPending});await drainAll();}

 record('tenant B financial export unchanged through attacks 1-11 (B had no own events yet)',await bSame(),{});
 // 12. A merchant whose adapter access fails must not stop other merchants draining.
 {const e=event('evt_ivIsolated','invoice.finalized',accounts.B,'in_ivB');await deliver(e,sign(e));let threw=null,o=null;
  try{o=await drainAll([{...merchants[0],token:'revoked-'+randomUUID()},merchants[1]]);}catch(err){threw=String(err.message).slice(0,160);}
  const s=await snap();const bDone=rows(s,'B','evt_ivIsolated')[0]?.done;
  record('drain isolates a failing merchant from other merchants',threw===null&&bDone===true,{threw,bDone,outcomes:o});
  await drainAll();}

 // 13. Liveness: 100 receipts that the real provider client fails with 404 (not "No such object") never close; a later valid receipt starves.
 {const ids=[];for(let i=0;i<100;i++){const e=event('evt_ivGone'+i,'invoice.updated',accounts.A,'in_ivGone');ids.push(await deliver(e,sign(e)));}
  const o1=await drainAll();const resultCounts=o1.reduce((a,x)=>(a[x.result]=(a[x.result]??0)+1,a),{});
  const e=event('evt_ivAfterGone','invoice.updated',accounts.A,'in_ivA');await deliver(e,sign(e));const o2=await drainAll();const o3=await drainAll();const s=await snap();
  const late=rows(s,'A','evt_ivAfterGone')[0];
  record('liveness: provider-404 receipts are closed or skipped so later receipts still drain',late?.done===true,{deliveries200:ids.filter(x=>x===200).length,firstDrain:resultCounts,sampleReason:o1.find(x=>x.result!=='applied')?.reason,laterReceiptDone:late?.done,laterDrainTouchedIt:[...o2,...o3].some(x=>x.eventId==='evt_ivAfterGone'),receiptsQueryUsable:s.A.receipts!==null});}

 // 14. Observation: a refund notification names a charge, not an invoice. What happens to it?
 {const bf=await snap();const e=Buffer.from(JSON.stringify({id:'evt_ivRefund',object:'event',livemode:false,created:t(),type:'charge.refunded',account:accounts.B,data:{object:{id:'ch_ivB',object:'charge',invoice:'in_ivB'}}}));
  const s1=await deliver(e,sign(e));const o=await drainAll();const af=await snap();
  report.observations=[{name:'charge.refunded for bound account B (charge id, not invoice id)',status:s1,outcome:o.find(x=>x.eventId==='evt_ivRefund'),receiptClosed:rows(af,'B','evt_ivRefund')[0]?.done,observedDelta:af.B.observed-bf.B.observed}];
  console.log('OBSERVATION '+JSON.stringify(report.observations));}
 // ===================== Round 2 verifier attacks =====================
 const drainAt=(now,list=merchants,backoffMs=30_000)=>drain({...deps,merchants:list,reconcile,ack,backoffMs,now:()=>now});
 const one=async(n,id)=>(await client.query(api.callbackIngestion.receipts,{token:f[n].adapter,binding:f[n].binding,eventId:id}))[0];
 const kinds=n=>run('paymentFixture:counts',{org:f[n].org}).events.map(e=>e.kind);
 const codeOfErr=e=>e?.name==='ConvexError'?e.data?.code:'plain:'+String(e?.message).slice(0,60);
 const tryCode=async fn=>{try{await fn();return 'no-error';}catch(e){return codeOfErr(e);}};
 let bR2=(await snap()).B.finance;

 // R2-0. Redaction mode is really in force (a frozen plain Error must lose its text when redacted).
 {let msg=null;try{await q('pendingEvents',{token:f.B.adapter,binding:f.A.binding});}catch(e){msg=String(e.message);}
  record('R2-0 redaction mode as configured',REDACT?msg==='[Request ID: redacted] Server Error':/adapter account denied/.test(msg??''),{REDACT,msg:msg?.slice(0,80)});}

 // R2-1. Item isolation: an ack failure on one receipt does not stop the next; it is retried later.
 {const e1=event('evt_r2Item1','invoice.updated',accounts.A,'in_ivA'),e2=event('evt_r2Item2','invoice.updated',accounts.A,'in_ivA');await deliver(e1,sign(e1));await deliver(e2,sign(e2));
  ackFailNext=true;const o1=await drainAll();const r1=await one('A','evt_r2Item1'),r2=await one('A','evt_r2Item2');const o2=await drainAll();const r1b=await one('A','evt_r2Item1');
  record('R2-1 per-receipt isolation: failing ack on one receipt, next still applied, first applied later',o1.find(x=>x.eventId==='evt_r2Item1')?.result==='item_error'&&r1?.done===false&&r2?.done===true&&r1b?.done===true,{o1,o2});}

 // R2-2. Revoked merchant in the middle of the list is reported with a typed code and skipped.
 {const e=event('evt_r2Mid','invoice.finalized',accounts.B,'in_ivB');await deliver(e,sign(e));
  let threw=null,o=null;try{o=await drainAll([merchants[0],{...merchants[0],name:'X',token:'revoked-'+randomUUID()},merchants[1]]);}catch(err){threw=codeOfErr(err);}
  record('R2-2 revoked merchant in the middle: merchant_error adapter_denied, later merchant drains',threw===null&&o.some(x=>x.merchant==='X'&&x.result==='merchant_error'&&x.code==='adapter_denied')&&(await one('B','evt_r2Mid'))?.done===true,{threw,o});}

 // R2-3. Classification of real error shapes (pure function from the copy under test).
 {const S=(st,code)=>new StripeFailure(st,{type:'invalid_request_error',...(code?{code}:{})},'req_sim');
  const table={s400:[S(400,'parameter_invalid_empty'),true],s402:[S(402,'card_declined'),true],s404:[S(404,'resource_missing'),true],
   s408:[S(408),false],s409:[S(409,'idempotency_key_in_use'),false],s429:[S(429,'rate_limit'),false],s500:[S(500),false],s502:[S(502),false],s503:[S(503),false],
   fetchTypeError:[new TypeError('fetch failed'),false],abortTimeout:[new DOMException('The operation was aborted due to timeout','TimeoutError'),false],
   outcomeUnknown:[new OutcomeUnknown(),false],assertion:[new assert.AssertionError({message:'Live response refused'}),true],
   redactedPlain:[new Error('[Request ID: redacted] Server Error'),false],convexCode:[new ConvexError({code:'adapter_denied'}),false]};
  const got={};let ok=true;for(const [k,[err,final]] of Object.entries(table)){let c;try{c=classify(err);}catch(e){c={threw:String(e.message)};}got[k]=c;if(c.final!==final)ok=false;}
  record('R2-3 classify matches the stated rule for 400/402/404 final and 408/409/429/5xx/network/timeout/unknown retryable',ok,got);
  const auth={s401:classify(S(401)),s403:classify(S(403,'account_invalid'))};
  record('R2-3b platform credential/permission failures (401, 403) are not final for the event',!auth.s401.final&&!auth.s403.final,auth);
  const odd={};for(const [k,v] of Object.entries({stringThrown:'boom',numberThrown:7,nullThrown:null}))try{odd[k]=classify(v);}catch(e){odd[k]={threw:String(e.message).slice(0,80)};}
  record('R2-3c classify tolerates non-Error throws',Object.values(odd).every(c=>!c.threw),odd);}

 // R2-4. Integrated: 401 from the provider closes the receipt? 429 retries?
 {failPath['/v1/invoices/in_r2Auth']=()=>new StripeFailure(401,{type:'invalid_request_error'},'req_sim');failPath['/v1/invoices/in_r2Rate']=()=>new StripeFailure(429,{type:'invalid_request_error',code:'rate_limit'},'req_sim');
  const ea=event('evt_r2Auth','invoice.paid',accounts.A,'in_r2Auth'),er=event('evt_r2Rate','invoice.paid',accounts.A,'in_r2Rate');await deliver(ea,sign(ea));await deliver(er,sign(er));
  const o=await drainAt(Date.now());const ra=await one('A','evt_r2Auth'),rr=await one('A','evt_r2Rate');
  record('R2-4 integrated 429 is deferred, not closed',o.find(x=>x.eventId==='evt_r2Rate')?.result==='retry'&&rr.done===false,{o:o.filter(x=>x.eventId.startsWith('evt_r2'))});
  record('R2-4b integrated 401 (expired or rotated platform key) does not permanently close the receipt',ra.done===false,{outcome:o.find(x=>x.eventId==='evt_r2Auth'),done:ra.done,auditTail:kinds('A').filter(k=>k.includes('provider_401'))});
  delete failPath['/v1/invoices/in_r2Auth'];delete failPath['/v1/invoices/in_r2Rate'];}

 // R2-5. Backoff schedule and 5-attempt cap with real backoff (30s base), newer receipt not starved.
 {failPath['/v1/invoices/in_r2Flaky']=()=>new StripeFailure(503,{type:'api_error'},'req_sim');
  const e=event('evt_r2Flaky','invoice.paid',accounts.A,'in_r2Flaky');await deliver(e,sign(e));const T=Date.now()+10_000_000;const trace=[];
  const step=async(dt,label)=>{const o=await drainAt(T+dt);const x=o.find(y=>y.eventId==='evt_r2Flaky');trace.push({label,dt,result:x?.result??'skipped',attempts:x?.attempts});return x;};
  await step(0,'first');await step(1000,'early');
  const en=event('evt_r2Newer','invoice.updated',accounts.A,'in_ivA');await deliver(en,sign(en));const on=await drainAt(T+2000);const newerApplied=on.find(y=>y.eventId==='evt_r2Newer')?.result==='applied';
  await step(29_999,'just before 30s');await step(30_000,'at 30s');await step(89_999,'just before +60s');await step(90_000,'at +60s');await step(210_000,'at +120s');await step(449_999,'just before +240s');await step(450_000,'at +240s');await step(5_000_000,'much later');
  const r=await one('A','evt_r2Flaky');const failedAudit=kinds('A').filter(k=>k==='payment.callback.failed:provider_503').length;
  const docFlaky=(await snap()).A.finance.documents.find(d=>d.externalId==='in_r2Flaky');
  const expect=[['first','retry',1],['early','skipped'],['just before 30s','skipped'],['at 30s','retry',2],['just before +60s','skipped'],['at +60s','retry',3],['at +120s','retry',4],['just before +240s','skipped'],['at +240s','failed',5],['much later','skipped']];
  const pass=expect.every(([l,res,at])=>{const t=trace.find(x=>x.label===l);return t&&t.result===res&&(at===undefined||t.attempts===at);})&&r.done===true&&failedAudit===1&&newerApplied;
  record('R2-5 exponential backoff 30/60/120/240s, closed as failed at attempt 5 with one audit row, newer receipt not starved',pass,{trace,done:r.done,failedAudit,newerApplied,docAfterFailure:{state:docFlaky?.state,adjustmentsComplete:docFlaky?.adjustmentsComplete}});
  delete failPath['/v1/invoices/in_r2Flaky'];}

 // R2-6. Unsupported types are refused with a typed code and never read the provider.
 {const types=[['charge.refunded','ch_r2'],['charge.dispute.created','dp_r2'],['credit_note.created','cn_r2'],['customer.subscription.updated','sub_r2'],['invoice_payment.paid','inpay_r2'],['invoiceitem.created','ii_r2']];
  const readsBefore=providerReads.length;const st=[];for(const [ty,obj] of types){const e=event('evt_r2T_'+ty,ty,accounts.A,obj);st.push(await deliver(e,sign(e)));}
  const ec=event('evt_r2ChargeAsInvoice','invoice.paid',accounts.A,'ch_r2');st.push(await deliver(ec,sign(ec)));
  const o=await drainAll();const mine=o.filter(x=>x.eventId.startsWith('evt_r2T_')||x.eventId==='evt_r2ChargeAsInvoice');const audit=kinds('A');
  const pass=st.every(s=>s===200)&&mine.length===7&&mine.filter(x=>x.code==='unsupported_event_type').length===6&&mine.find(x=>x.eventId==='evt_r2ChargeAsInvoice')?.code==='unbound_document'&&mine.every(x=>x.result==='refused')&&providerReads.length===readsBefore&&audit.filter(k=>k==='payment.callback.refused:unsupported_event_type').length>=6;
  record('R2-6 non-invoice types refused unsupported_event_type, invoice event naming a charge refused unbound_document, zero provider reads',pass,{statuses:st,outcomes:mine,newReads:providerReads.length-readsBefore});}

 // R2-7. ConvexError codes survive redaction on every new function.
 {const e=event('evt_r2Codes','invoice.finalized',accounts.A,'in_ivA');await deliver(e,sign(e));const item=(await deps.due(merchants[0],Date.now())).find(x=>x.eventId==='evt_r2Codes');
  const c={refuseBadCode:await tryCode(()=>client.mutation(api.callbackIngestion.refuse,{token:f.A.adapter,id:item.id,reason:'Bad Code'})),
   deferBadCode:await tryCode(()=>client.mutation(api.callbackIngestion.defer,{token:f.A.adapter,id:item.id,code:'x y',now:0,backoffMs:0})),
   prepareWrongTenant:await tryCode(()=>client.query(api.callbackIngestion.prepare,{token:f.B.adapter,id:item.id})),
   deferWrongTenant:await tryCode(()=>client.mutation(api.callbackIngestion.defer,{token:f.B.adapter,id:item.id,code:'x',now:0,backoffMs:0})),
   dueWrongTenant:await tryCode(()=>client.query(api.callbackIngestion.due,{token:f.B.adapter,binding:f.A.binding,now:0})),
   parkNoIngress:await tryCode(()=>client.mutation(api.callbackIngestion.park,{token:f.A.adapter,account:'acct_r2Z',eventId:'evt_z',type:'invoice.paid',digest:'d'})),
   parkBadAccount:await tryCode(()=>client.mutation(api.callbackIngestion.park,{token:ingressToken,account:'acct_bad!',eventId:'evt_z',type:'invoice.paid',digest:'d'})),
   parkBoundAccount:await tryCode(()=>client.mutation(api.callbackIngestion.park,{token:ingressToken,account:accounts.A,eventId:'evt_z',type:'invoice.paid',digest:'d'})),
   parkedNoIngress:await tryCode(()=>client.query(api.callbackIngestion.parked,{token:f.A.adapter}))};
  const want={refuseBadCode:'invalid_code',deferBadCode:'invalid_code',prepareWrongTenant:'adapter_denied',deferWrongTenant:'adapter_denied',dueWrongTenant:'adapter_denied',parkNoIngress:'ingress_denied',parkBadAccount:'invalid_account',parkBoundAccount:'account_bound',parkedNoIngress:'ingress_denied'};
  record('R2-7 each new function refuses with the expected ConvexError code through redaction',Object.entries(want).every(([k,v])=>c[k]===v)&&(await one('A','evt_r2Codes')).done===false,c);await drainAll();}

 // B is reconciled for real in R2-2; B's financial baseline for the parking attacks is taken here.
 bR2=(await snap()).B.finance;
 // R2-8. Parking: 200, one row, alert; redelivery; different body same id; bound-but-unconfigured account; no effect.
 {const parkedNow=()=>client.query(api.callbackIngestion.parked,{token:ingressToken});
  const e=event('evt_r2Park','invoice.paid',"acct_r2Unbound",'in_ivA'),e2=event('evt_r2Park','invoice.voided',"acct_r2Unbound",'in_ivA');
  const aBefore=(await snap()).A.finance;
  const s1=await deliver(e,sign(e)),s2=await deliver(e,sign(e,t()+1)),s3=await deliver(e2,sign(e2));const p=await parkedNow();
  const mine=p.rows.filter(r=>r.account==='acct_r2Unbound'),al=p.alerts.find(a=>a.kind==='parked'&&a.account==='acct_r2Unbound');
  // Second receiver whose merchant list lacks B, although B is bound in the database.
  const srv2=createServer(createReceiver({verify:verifyStripe,secret,merchants:[merchants[0]],ingest:ingestFor,park:deps.park}));await new Promise(r=>srv2.listen(PORTS.receiver2,'127.0.0.1',r));
  const eb=event('evt_r2BoundElsewhere','invoice.paid',accounts.B,'in_ivB');const r2=await fetch('http://127.0.0.1:'+PORTS.receiver2+'/stripe',{method:'POST',headers:{'Stripe-Signature':sign(eb)},body:eb});await r2.text();srv2.closeAllConnections();await new Promise(r=>srv2.close(r));
  const p2=await parkedNow();const aAfter=(await snap()).A.finance;
  const pass=s1===200&&s2===200&&s3===200&&mine.length===1&&mine[0].type==='invoice.paid'&&al?.count===1&&r2.status===400&&!p2.rows.some(r=>r.account===accounts.B)&&!(await one('B','evt_r2BoundElsewhere'))&&JSON.stringify(aBefore)===JSON.stringify(aAfter)&&await (async()=>JSON.stringify((await snap()).B.finance)===JSON.stringify(bR2))();
  record('R2-8 unbound account parked once with one alert; bound-in-DB account missing from receiver config gets 400; no financial effect',pass,{statuses:[s1,s2,s3],rows:mine,alert:al,boundElsewhereStatus:r2.status});
  report.observations.push({name:'parked duplicate with a different body is accepted as duplicate (no digest comparison)',status:s3,keptType:mine[0]?.type});}

 // R2-9. Park cap: fill to 500, then the 501st.
 {const p0=await client.query(api.callbackIngestion.parked,{token:ingressToken});let n=p0.rows.length;
  for(let i=0;n<500;i++){const r=await client.mutation(api.callbackIngestion.park,{token:ingressToken,account:'acct_r2Fill'+(i%5),eventId:'evt_r2Fill'+i,type:'invoice.paid',digest:'d'+i});if(r.parked)n++;}
  const e=event('evt_r2Overflow','invoice.paid','acct_r2Over','in_ivA');const s1=await deliver(e,sign(e));const s2=await deliver(e,sign(e,t()+1));
  const e3=event('evt_r2Overflow2','invoice.paid','acct_r2Over','in_ivA');const s3=await deliver(e3,sign(e3));
  const p=await client.query(api.callbackIngestion.parked,{token:ingressToken});const ov=p.alerts.find(a=>a.kind==='park_overflow'&&a.account==='acct_r2Over');
  const dupAtCap=await client.mutation(api.callbackIngestion.park,{token:ingressToken,account:'acct_r2Fill0',eventId:'evt_r2Fill0',type:'invoice.paid',digest:'d0'});
  record('R2-9 at 501 the event gets 200, is not stored, and raises a park_overflow alert; rows stay 500',s1===200&&s2===200&&s3===200&&p.rows.length===500&&!p.rows.some(r=>r.account==='acct_r2Over')&&ov?.count===3&&dupAtCap.duplicate===true,{statuses:[s1,s2,s3],rows:p.rows.length,overflowAlert:ov,alertRowsShown:p.alerts.length,dupAtCap});}

 // R2-10. Schema: deployed payment_schema.ts is byte-identical to frozen convex/schema.ts; callback tables do not shadow base tables.
 {const baseSrc=readFileSync(here+'convex/schema.ts','utf8'),deployed=readFileSync(cwd+'/convex/payment_schema.ts','utf8'),cb=readFileSync(here+'callback/schema.ts','utf8');
  const names=s=>[...s.matchAll(/(\w+):\s*defineTable/g)].map(m=>m[1]);const overlap=names(cb).filter(n=>names(baseSrc).includes(n));
  record('R2-10 frozen schema deployed unchanged and callback tables are purely additive',baseSrc===deployed&&overlap.length===0&&/\.\.\.base\.tables/.test(cb)&&!/defineSchema\([^)]*,\s*\{/.test(baseSrc),{added:names(cb),overlap});}

 record('R2 tenant B finance unchanged through parking, cap and schema attacks (R2-8 to R2-10)',JSON.stringify((await snap()).B.finance)===JSON.stringify(bR2),{});

 // R2-11. Scan window: 1001 receipts backing off ahead of a newer valid receipt (only with --scan).
 if(process.argv.includes('--scan')){failPath['/v1/invoices/in_r2Flood']=()=>new StripeFailure(503,{type:'api_error'},'req_sim');const T=Date.now()+50_000_000;
  const all=[];for(let i=0;i<1001;i++){const e=event('evt_r2Flood'+i,'invoice.updated',accounts.A,'in_r2Flood');all.push(deliver(e,sign(e)));if(all.length%50===0)await Promise.all(all.splice(0));}await Promise.all(all);
  let drains=0,deferred=0;for(;;){const o=await drainAt(T);drains++;const k=o.filter(x=>x.eventId.startsWith('evt_r2Flood')).length;deferred+=k;if(k===0||drains>30)break;}
  const ev=event('evt_r2AfterFlood','invoice.updated',accounts.A,'in_ivA');await deliver(ev,sign(ev));
  let dueErr=null,o1;try{o1=await drainAt(T);}catch(e){dueErr=codeOfErr(e);}
  const sameClock=(await one('A','evt_r2AfterFlood')).done;const merchantErr=o1?.find(x=>x.result==='merchant_error');
  let later=0;for(;later<30;){const o=await drainAt(T+30_000);later++;if(o.some(x=>x.eventId==='evt_r2AfterFlood'))break;}
  const laterDone=(await one('A','evt_r2AfterFlood')).done;
  record('R2-11 newer receipt drains at the same clock behind 1001 backing-off receipts',sameClock===true,{drainsToDeferAll:drains,deferred,dueErr,merchantErr,sameClockDone:sameClock,drainsAfterBackoffUntilReached:later,laterDone});
  delete failPath['/v1/invoices/in_r2Flood'];}
 report.providerReads={total:providerReads.length,byAccount:Object.fromEntries(Object.values(accounts).map(a=>[a,providerReads.filter(r=>r.account===a).length]))};
}finally{await new Promise(r=>server?server.close(r):r());await stop();writeFileSync(cwd+'/backend.log',log,{mode:0o600});}
report.finishedAt=new Date().toISOString();
writeFileSync(out+mutant+'.json',JSON.stringify(report,null,1)+'\n');
process.exit(0);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function inUse(port){return new Promise(r=>{const s=createConnection({port,host:'127.0.0.1'});s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});}
