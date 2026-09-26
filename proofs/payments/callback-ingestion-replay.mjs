// SERVICE/SIM replay of durable callback ingestion. Local Convex on 3620/3621, receiver on 3622,
// synthetic signing secret, in-process provider-state stub. No Stripe calls of any kind.
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

const here=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../',import.meta.url));
const out=here+'evidence/callback-ingestion/';
const PORTS={cloud:3620,site:3621,receiver:3622};
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.split('=')[1];

// Each mutant removes exactly one guard from the real source, in a private copy.
const MUTANTS={
 dedupe:{file:'convex/payments.ts',from:"if (old) {\n            if (old.digest !== a.digest)\n                deny('event integrity mismatch');\n            return false;\n        }\n        const { token, ...row } = a;",to:"const { token, ...row } = a;"},
 signature:{file:'webhooks.mjs',from:"if(!fields.filter(([k])=>k==='v1').some(([,value])=>{const actual=Buffer.from(value??'','hex');return actual.length===expected.length&&timingSafeEqual(actual,expected)}))throw new Error('Webhook signature refused');",to:''},
 account:{file:'callback-ingestion.mjs',from:'merchants.find(m=>m.account===event.account)',to:'merchants.find(()=>true)'},
};

if(process.argv.includes('--all'))await all();else await one(arg('mode')??'after',arg('mutant')??'none');

async function all(){
 mkdirSync(out,{recursive:true});
 const runs=[['baseline','none','fail'],['after','none','pass'],['after','dedupe','fail'],['after','signature','fail'],['after','account','fail']],summary=[];
 for(const [mode,mutant,expected] of runs){
  const code=await new Promise(r=>spawn(process.execPath,[fileURLToPath(import.meta.url),'--mode='+mode,'--mutant='+mutant],{stdio:'inherit'}).once('close',r));
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
 for(const name of ['tsconfig.json','package.json','webhooks.mjs','callback-ingestion.mjs'])cpSync(here+name,cwd+'/'+name);
 writeFileSync(cwd+'/convex.json','{"functions":"convex"}');symlinkSync(root+'node_modules',cwd+'/node_modules','dir');
 if(mutant!=='none'){const m=MUTANTS[mutant],path=cwd+'/'+m.file,text=readFileSync(path,'utf8');assert.equal(text.split(m.from).length,2,'Mutant anchor must match exactly once: '+mutant);writeFileSync(path,text.replace(m.from,m.to));}
 const {verifyStripe}=await import(pathToFileURL(cwd+'/webhooks.mjs'));
 const {createReceiver,drain}=await import(pathToFileURL(cwd+'/callback-ingestion.mjs'));

 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1',CI:'1'};
 const cli=root+'node_modules/convex/bin/main.js';let backend,log='';
 const run=(path,args={})=>{try{const t=execFileSync(process.execPath,[cli,'run',path,JSON.stringify(args)],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000});return t.trim()?JSON.parse(t):null;}catch{throw Error('Local function refused: '+path);}};
 const start=async()=>{log='';backend=spawn(process.execPath,[cli,'dev','--local-cloud-port',String(PORTS.cloud),'--local-site-port',String(PORTS.site),'--typecheck','enable','--tail-logs','disable'],{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
  for(const s of [backend.stdout,backend.stderr])s.on('data',b=>log+=b);
  const end=Date.now()+180_000;while(!log.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>end)throw Error('Local backend not ready; private log retained');await sleep(150);}};
 const stop=async()=>{if(!backend)return;const b=backend;backend=null;const closed=new Promise(r=>b.once('close',r));try{process.kill(-b.pid,'SIGTERM');}catch{}await closed;};

 const secret='whsec_'+randomBytes(24).toString('hex'),wrong='whsec_'+randomBytes(24).toString('hex');
 const report={level:'SERVICE/SIM builder run: local Convex backend, loopback HTTP receiver, synthetic signing secret, in-process provider-state stub. No Stripe API calls, no sandbox writes.',mode,mutant,ports:PORTS,startedAt:new Date().toISOString(),deliveries:[],drains:[],cases:[]};
 let server,client,crashNext=false;
 try{
  await start();
  const connect=()=>{client=new ConvexHttpClient('http://127.0.0.1:'+PORTS.cloud,{logger:false});};connect();
  const m=(n,a)=>client.mutation(api.payments[n],a),q=(n,a)=>client.query(api.payments[n],a);
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
  const accounts={A:'acct_simCallbackA',B:'acct_simCallbackB'};
  for(const n of ['A','B']){run('payments:configureFixture',{binding:f[n].binding,adapterToken:f[n].adapter,account:accounts[n],environment:'SIM',healthy:true});f[n].key={provider:'stripe',environment:'SIM',account:accounts[n]};}
  const docs={};
  for(const n of ['A','B']){const customer=run('paymentFixture:customer',{org:f[n].org,binding:f[n].binding,name:'Callback '+n});docs[n]=await m('prepareInvoice',{token:f[n].sessions.owner,customer,amountMinor:100,currency:'usd',kind:'invoice'});await m('attachProvider',{token:f[n].adapter,id:docs[n],externalId:'in_simCallback'+n});}
  const merchants=['A','B'].map(n=>({name:n,account:accounts[n],binding:f[n].binding,token:f[n].adapter}));

  // Provider-state stub: every object lives inside one connected account; reads name the account.
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
   const state=provider[account];if(!state)throw Error('No such object: account');
   const list=p=>({data:Object.entries(state).filter(([k,v])=>k.startsWith(p+'/')&&Object.entries(params).every(([pk,pv])=>pk==='limit'||pk==='starting_after'||v[pk]===pv)).map(([,v])=>v),has_more:false});
   if(['/v1/invoice_payments','/v1/refunds','/v1/credit_notes'].includes(path))return list(path);
   if(!state[path])throw Error('No such object: '+path);return structuredClone(state[path]);}};
  const adapter=trustedAdapter(stripe,client,f);

  const ingestFor=async(merchant,row)=>{await m('ingest',{token:merchant.token,binding:merchant.binding,...row});if(crashNext){crashNext=false;server.closeAllConnections();throw Error('crash after durable receipt');}};
  // Baseline: webhooks.mjs listen() handler body plus the sandbox-replay.mjs routing callback, unchanged in behavior.
  const baselineHandler=async(req,res)=>{
   if(req.method!=='POST'||req.url!=='/stripe'){res.writeHead(404).end();return;}
   try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw new Error('Body too large');chunks.push(chunk)}
    const raw=Buffer.concat(chunks);const event=verifyStripe(raw,req.headers['stripe-signature'],secret);const digest=createHash('sha256').update(raw).digest('hex');
    const merchant=merchants.find(x=>x.account===event.account);
    if(merchant)await ingestFor(merchant,{eventId:event.id,type:event.type,externalId:event.data.object.id,digest});
    res.writeHead(200).end('accepted');
   }catch{if(!res.destroyed)res.writeHead(400).end('refused');}};
  const listen=async()=>{const handler=mode==='baseline'?baselineHandler:createReceiver({verify:verifyStripe,secret,merchants,ingest:ingestFor});server=createServer(handler);await new Promise((r,j)=>{server.once('error',j);server.listen(PORTS.receiver,'127.0.0.1',r);});};
  const unlisten=async()=>{if(!server)return;server.closeAllConnections();await new Promise(r=>server.close(r));server=null;};
  await listen();

  let ackFailNext=false;
  const reconcile=(merchant,row)=>adapter.observe(merchant.name,row.externalId,row.eventId+':pull:'+randomUUID(),randomUUID());
  const ack=async(merchant,row)=>{if(ackFailNext){ackFailNext=false;throw Error('crash before acknowledgement');}await m('ackEvent',{token:merchant.token,id:row._id});};
  const pending=merchant=>q('pendingEvents',{token:merchant.token,binding:merchant.binding});
  const drainAll=async label=>{let outcomes;
   if(mode==='baseline'){outcomes=[];try{for(const merchant of merchants)for(const row of await pending(merchant)){await reconcile(merchant,row);await ack(merchant,row);outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'applied'});}}catch(error){outcomes.push({result:'stopped',reason:String(error.message).slice(0,200)});}}
   else outcomes=await drain({merchants,pending,reconcile,ack,refuse:(merchant,row,reason)=>client.mutation(api.callbackIngestion.refuse,{token:merchant.token,id:row._id,reason})});
   report.drains.push({label,outcomes});return outcomes;};

  const event=(id,type,account,object,created)=>Buffer.from(JSON.stringify({id,object:'event',api_version:'2025-05-28.basil',created,livemode:false,type,...(account===undefined?{}:{account}),data:{object:{id:object,object:'invoice'}}}));
  const sign=(raw,key=secret,t=Math.floor(Date.now()/1000))=>'t='+t+',v1='+createHmac('sha256',key).update(t+'.').update(raw).digest('hex');
  const deliver=async(label,raw,header)=>{let status;try{const r=await fetch('http://127.0.0.1:'+PORTS.receiver+'/stripe',{method:'POST',headers:{'Stripe-Signature':header,'Content-Type':'application/json'},body:raw});status=r.status;await r.text();}catch{status='no-response';}report.deliveries.push({label,status});return status;};

  const snap=async()=>{const s={};for(const n of ['A','B']){const events=run('paymentFixture:counts',{org:f[n].org}).events;const d=await q('getDocument',{token:f[n].sessions.owner,id:docs[n]});
   s[n]={receipts:await client.query(api.callbackIngestion.receipts,{token:f[n].adapter,binding:f[n].binding}),observed:events.filter(e=>e.kind==='payment.observed').length,refused:events.filter(e=>e.kind.startsWith('payment.callback.refused')).length,doc:{state:d.state,paidMinor:d.paidMinor,adjustmentsComplete:d.adjustmentsComplete??null},finance:await q('exportFinance',{token:f[n].sessions.owner})};}return s;};
  const rows=(s,n,id)=>s[n].receipts.filter(r=>r.eventId===id);
  const bBefore=(await snap()).B.finance,bChecks=[];
  const checkB=async(at,s)=>{bChecks.push({at,financeUnchanged:JSON.stringify(s.B.finance)===JSON.stringify(bBefore),observed:s.B.observed});};
  const record=(name,pass,detail)=>{report.cases.push({name,pass,detail});console.log((pass?'PASS ':'FAIL ')+name+' '+JSON.stringify(detail));};
  const t0=Math.floor(Date.now()/1000);

  // 1. Bad signature, tampered body, stale timestamp: refused before any durable write.
  {const before=await snap();const e=event('evt_simBadSig','invoice.paid',accounts.A,'in_simCallbackA',t0);
   const s1=await deliver('wrong secret',e,sign(e,wrong));
   const good=event('evt_simTamper','invoice.paid',accounts.A,'in_simCallbackA',t0),h=sign(good);
   const s2=await deliver('tampered body',Buffer.from(good.toString().replace('invoice.paid','invoice.voided')),h);
   const s3=await deliver('stale timestamp',good,sign(good,secret,t0-600));
   await drainAll('after bad signatures');const after=await snap();await checkB('bad signature',after);
   const pass=[s1,s2,s3].every(s=>s===400)&&after.A.receipts.length===before.A.receipts.length&&after.B.receipts.length===before.B.receipts.length&&after.A.observed===before.A.observed;
   record('bad signature refused with no durable effect',pass,{statuses:[s1,s2,s3],receiptsA:after.A.receipts.length,receiptsB:after.B.receipts.length});}

  // 2. Crash after the receipt is durable but before acknowledgement and reconciliation; restart; provider redelivers.
  const e1=event('evt_simFinalized','invoice.finalized',accounts.A,'in_simCallbackA',t0+1);
  let replayHeader;
  {const before=await snap();crashNext=true;const s1=await deliver('first delivery, crash after receipt',e1,sign(e1));
   await unlisten();await stop();await start();connect();await listen();
   const survived=rows(await snap(),'A','evt_simFinalized');
   replayHeader=sign(e1);const s2=await deliver('provider redelivery after restart',e1,replayHeader);
   const outcomes=await drainAll('after restart');const after=await snap();await checkB('crash',after);
   const r=rows(after,'A','evt_simFinalized');
   const pass=s1==='no-response'&&survived.length===1&&survived[0].done===false&&s2===200&&r.length===1&&r[0].done===true&&after.A.observed-before.A.observed===1&&after.A.doc.state==='open'&&after.A.doc.adjustmentsComplete===true&&rows(after,'B','evt_simFinalized').length===0;
   record('crash between durable receipt and reconciliation, then restart',pass,{firstDelivery:s1,receiptsAfterRestart:survived.length,redelivery:s2,receipts:r.length,observations:after.A.observed-before.A.observed,doc:after.A.doc,outcomes});}

  // 3. Exact replay: same bytes, same signature header.
  {const before=await snap();const s=await deliver('exact replay',e1,replayHeader);const outcomes=await drainAll('after replay');const after=await snap();await checkB('replay',after);
   const pass=s===200&&rows(after,'A','evt_simFinalized').length===1&&after.A.receipts.length===before.A.receipts.length&&after.A.observed===before.A.observed;
   record('exact replay produces no second effect',pass,{status:s,receipts:rows(after,'A','evt_simFinalized').length,observations:after.A.observed-before.A.observed,outcomes});}

  // 4. Out of order: the newer paid event is processed first, then an older update arrives late.
  {const before=await snap();payA();
   const paid=event('evt_simPaid','invoice.paid',accounts.A,'in_simCallbackA',t0+3),older=event('evt_simUpdatedEarlier','invoice.updated',accounts.A,'in_simCallbackA',t0+2);
   const s1=await deliver('newer paid event',paid,sign(paid));const o1=await drainAll('after newer event');const mid=await snap();
   const s2=await deliver('older update event, late',older,sign(older));const o2=await drainAll('after older event');const after=await snap();await checkB('out of order',after);
   const pass=s1===200&&s2===200&&rows(after,'A','evt_simPaid').length===1&&rows(after,'A','evt_simUpdatedEarlier').length===1&&after.A.receipts.every(r=>r.done)&&after.A.observed-before.A.observed===2&&mid.A.doc.state==='paid'&&after.A.doc.state==='paid'&&after.A.doc.paidMinor===100&&after.A.doc.adjustmentsComplete===true;
   record('out-of-order events converge to provider state without regression',pass,{statuses:[s1,s2],docAfterNewer:mid.A.doc,docAfterOlder:after.A.doc,observations:after.A.observed-before.A.observed,outcomes:[...o1,...o2]});}

  // 5. Substitution: validly signed events naming an unbound account, no account, or the other merchant's account for A's object.
  {const before=await snap();
   const c=event('evt_simUnbound','invoice.voided',"acct_simCallbackC",'in_simCallbackA',t0+4),none=event('evt_simPlatform','invoice.voided',undefined,'in_simCallbackA',t0+4),sub=event('evt_simSubstituted','invoice.voided',accounts.B,'in_simCallbackA',t0+4);
   const sc=await deliver('unbound account',c,sign(c)),sn=await deliver('no connected account',none,sign(none)),ss=await deliver('claims merchant B for A object',sub,sign(sub));
   const outcomes=await drainAll('after substitution');const after=await snap();await checkB('substitution',after);
   const nowhere=id=>rows(after,'A',id).length===0&&rows(after,'B',id).length===0,subB=rows(after,'B','evt_simSubstituted');
   const pass=sc===400&&sn===400&&nowhere('evt_simUnbound')&&nowhere('evt_simPlatform')&&ss===200&&rows(after,'A','evt_simSubstituted').length===0&&subB.length===1&&subB[0].done===true&&after.B.refused===1&&after.B.observed===0&&after.A.observed===before.A.observed&&JSON.stringify(after.A.doc)===JSON.stringify(before.A.doc)&&[...after.A.receipts,...after.B.receipts].every(r=>r.done);
   record('substituted account refused or bound only to the claimed merchant, no effect on A',pass,{statuses:{unbound:sc,noAccount:sn,claimsB:ss},receiptsUnderB:subB,receiptsUnderA:after.A.receipts.filter(r=>r.eventId.includes('Unbound')||r.eventId.includes('Platform')||r.eventId.includes('Substituted')).length,refusedOnB:after.B.refused,docA:after.A.doc,outcomes});}

  // 7. Extra probe (not one of the required cases): crash after the ledger write but before acknowledgement.
  {const before=await snap();const e=event('evt_simUpdatedLate','invoice.updated',accounts.A,'in_simCallbackA',t0+5);const s=await deliver('update event',e,sign(e));
   ackFailNext=true;const o1=await drainAll('ack lost');await stop();await start();connect();const o2=await drainAll('after restart');const after=await snap();await checkB('ack-loss probe',after);
   const r=rows(after,'A','evt_simUpdatedLate');
   report.probe={name:'crash after ledger write, before acknowledgement',status:s,receipts:r.length,done:r[0]?.done,observationsWritten:after.A.observed-before.A.observed,docBefore:before.A.doc,docAfter:after.A.doc,outcomes:[...o1,...o2]};
   console.log('PROBE '+JSON.stringify(report.probe));}

  // 6. Tenant B unchanged at every checkpoint.
  record('tenant B financial state unchanged throughout',bChecks.every(c=>c.financeUnchanged&&c.observed===0),{checkpoints:bChecks});
  report.providerReads={total:providerReads.length,byAccount:Object.fromEntries(Object.values(accounts).map(a=>[a,providerReads.filter(r=>r.account===a).length]))};
 }finally{
  await new Promise(r=>server?server.close(r):r());await stop();writeFileSync(cwd+'/backend.log',log,{mode:0o600});
 }
 report.finishedAt=new Date().toISOString();
 writeFileSync(out+label(mode,mutant)+'.json',JSON.stringify(report,null,1)+'\n');
 process.exit(report.cases.every(c=>c.pass)?0:1);
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function inUse(port){return new Promise(r=>{const s=createConnection({port,host:'127.0.0.1'});s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});}
