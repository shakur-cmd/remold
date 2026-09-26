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
import {StripeFailure} from './stripe.mjs';
import {renameSync} from 'node:fs';

const here=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../',import.meta.url));
const out=here+'evidence/callback-ingestion/fix/'+(process.env.IV_OUT??'iv-before')+'/';
const PORTS={cloud:3730,site:3731,receiver:3732};
const mutant=process.argv.find(a=>a.startsWith('--mutant='))?.split('=')[1]??'none';

// Verifier-authored mutants. Each anchor must match exactly once in the private copy.
const MUTANTS={
 'ack-before-store':{file:'callback-ingestion.mjs',from:"   await ingest(merchant,{eventId:event.id,type:event.type,externalId,digest:createHash('sha256').update(raw).digest('hex')});\n   res.writeHead(200).end('accepted');",to:"   res.writeHead(200).end('accepted');\n   await ingest(merchant,{eventId:event.id,type:event.type,externalId,digest:createHash('sha256').update(raw).digest('hex')});"},
 'ack-on-error':{file:'callback-ingestion.mjs',from:"else outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'retry'",to:"else {await ack(merchant,row);outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'retry'});}if(0)outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'retry'"},
 'final-everything':{file:'callback-ingestion.mjs',from:"const FINAL=/unbound provider document|currency mismatch|invoice total mismatch|Non-sandbox|No such object/;",to:"const FINAL=/[^]+/;"},
 'header-binding':{file:'callback-ingestion.mjs',from:"merchants.find(m=>m.account===event.account)",to:"merchants.find(m=>m.account===(req.headers['stripe-account']??event.account))"},
 'refuse-scope':{file:'convex/callbackIngestion.ts',from:"    const b = await adapter(ctx, a.token, e.binding);\n    if (e.done) return false;",to:"    const b = (await ctx.db.get(e.binding))!;\n    if (e.done) return false;"},
 'digest-compare':{file:'convex/payments.ts',from:"            if (old.digest !== a.digest)\n                deny('event integrity mismatch');\n            return false;\n        }\n        const { token, ...row } = a;",to:"            return false;\n        }\n        const { token, ...row } = a;"},
};

const report={level:'SERVICE/SIM independent verifier run; no Stripe calls, no sandbox writes',mutant,ports:PORTS,startedAt:new Date().toISOString(),attacks:[]};
for(const port of Object.values(PORTS))assert.equal(await inUse(port),false,'Port busy: '+port);
mkdirSync(here+'private',{recursive:true,mode:0o700});mkdirSync(out,{recursive:true});
const cwd=mkdtempSync(here+'private/iv-attacks-'+mutant+'-');
cpSync(here+'convex',cwd+'/convex',{recursive:true});
renameSync(cwd+'/convex/schema.ts',cwd+'/convex/payment_schema.ts');for(const n of ['schema.ts','callbackIngestion.ts'])cpSync(here+'callback/'+n,cwd+'/convex/'+n);
for(const name of ['tsconfig.json','package.json','webhooks.mjs','callback-ingestion.mjs'])cpSync(here+name,cwd+'/'+name);
writeFileSync(cwd+'/convex.json','{"functions":"convex"}');symlinkSync(root+'node_modules',cwd+'/node_modules','dir');
if(mutant!=='none'){const m=MUTANTS[mutant];assert.ok(m,'unknown mutant');const path=cwd+'/'+m.file,text=readFileSync(path,'utf8');assert.equal(text.split(m.from).length,2,'anchor must match once: '+mutant);writeFileSync(path,text.replace(m.from,m.to));}
const {verifyStripe}=await import(pathToFileURL(cwd+'/webhooks.mjs'));
const {createReceiver,drain,convexDeps}=await import(pathToFileURL(cwd+'/callback-ingestion.mjs'));

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
 docs.A=await mkDoc('A','in_ivA');docs.B=await mkDoc('B','in_ivB');docs.Agone=await mkDoc('A','in_ivGone');
 const merchants=['A','B'].map(n=>({name:n,account:accounts[n],binding:f[n].binding,token:f[n].adapter}));

 const provider={[accounts.A]:{},[accounts.B]:{}};
 const invoice=(id,paid)=>({id,object:'invoice',livemode:false,status:paid?'paid':'open',currency:'usd',total:100,amount_due:100,amount_paid:paid?100:0,amount_remaining:paid?0:100,starting_balance:0,amount_overpaid:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0});
 provider[accounts.A]['/v1/invoices/in_ivA']=invoice('in_ivA',false);provider[accounts.B]['/v1/invoices/in_ivB']=invoice('in_ivB',false);
 const providerReads=[];let transientOnce=0;
 const stripe={request:async(method,path,params={},account)=>{
  assert.equal(method,'GET');providerReads.push({account,path});
  if(transientOnce>0){transientOnce--;throw Error('fetch failed ECONNRESET');}
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
 report.providerReads={total:providerReads.length,byAccount:Object.fromEntries(Object.values(accounts).map(a=>[a,providerReads.filter(r=>r.account===a).length]))};
}finally{await new Promise(r=>server?server.close(r):r());await stop();writeFileSync(cwd+'/backend.log',log,{mode:0o600});}
report.finishedAt=new Date().toISOString();
writeFileSync(out+mutant+'.json',JSON.stringify(report,null,1)+'\n');
process.exit(0);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function inUse(port){return new Promise(r=>{const s=createConnection({port,host:'127.0.0.1'});s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});}
