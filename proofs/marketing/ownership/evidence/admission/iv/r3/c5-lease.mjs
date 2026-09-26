// IV r3: attacks on the per-tenant reconciler lease (tenant A).
//  direct: acquire storm, stale/foreign/expired tokens, ttl bounds, edge key, foreign release.
//  skew:   a reconciler whose client clock is one hour ahead cannot take a live lease.
//  stall:  the real reconciler is SIGSTOPped after its last renew and before create, for longer than the lease;
//          a second reconciler takes over the same capture.
//  barrier: two instrumented reconcilers (timing only) both reach create at the same instant after the lease lapsed.
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import * as L from './lib3.mjs';
const section=process.argv[2],K=L.K,out={section};
const code=async fn=>{try{return {ok:await fn()};}catch(e){return {refused:e.code??String(e.message).slice(0,80)};}};
const acquire=(token,ttlMs=20000,key=K.a.reconciler)=>L.mutation('capture:acquire',{key,token,ttlMs});
const release=token=>L.mutation('capture:release',{key:K.a.reconciler,token});
if(section==='direct'){
 const tokens=Array.from({length:20},()=>L.nonce());
 const storm=await Promise.all(tokens.map(t=>code(()=>acquire(t))));
 const winners=tokens.filter((t,i)=>storm[i].ok!==undefined);
 out.storm={winners:winners.length,refusals:[...new Set(storm.filter(s=>s.refused).map(s=>s.refused))]};
 const w=winners[0],other=L.nonce();
 out.afterStorm={winnerRenews:await code(()=>L.mutation('capture:renew',{key:K.a.reconciler,token:w,ttlMs:20000})),newcomer:await code(()=>acquire(other)),loserRenews:await code(()=>L.mutation('capture:renew',{key:K.a.reconciler,token:tokens.find(t=>t!==w),ttlMs:20000}))};
 out.foreignRelease=await code(()=>release(other));out.stillHeld=await code(()=>acquire(other));
 const settled=(await L.inventory('a')).find(c=>c.status==='settled'&&c.outcome==='existing');
 out.staleSettle=await code(()=>L.mutation('capture:settle',{key:K.a.reconciler,lease:other,id:settled.id,outcome:'existing',contactId:settled.contactId}));
 out.edgeKeyAcquire=await code(()=>acquire(L.nonce(),20000,K.a.edge));
 out.otherTenantKeyAgainstA=await code(()=>L.mutation('capture:renew',{key:K.b.reconciler,token:w,ttlMs:20000}));
 out.ttl=Object.fromEntries(await Promise.all([[0],[-1],[1.5],[60001],[1e15],[60000]].map(async([ms])=>[String(ms),await code(()=>L.mutation('capture:renew',{key:K.a.reconciler,token:w,ttlMs:ms}))])));
 out.badToken=await code(()=>acquire('NOT-HEX'));
 await release(w);
 // Expiry is judged by the server clock: a 1 ms lease is stale for settle and free for others almost at once.
 const s=L.nonce();await acquire(s,1);await new Promise(r=>setTimeout(r,30));
 out.expired={settle:await code(()=>L.mutation('capture:settle',{key:K.a.reconciler,lease:s,id:settled.id,outcome:'existing',contactId:settled.contactId})),renew:await code(()=>L.mutation('capture:renew',{key:K.a.reconciler,token:s,ttlMs:20000})),takeover:await code(()=>acquire(L.nonce(),1))};
 out.verdict={oneWinner:winners.length===1,newcomerRefused:out.afterStorm.newcomer.refused==='leased',foreignReleaseNoop:out.stillHeld.refused==='leased',staleSettleRefused:out.staleSettle.refused==='stale',edgeRefused:out.edgeKeyAcquire.refused==='credential',ttlBounds:Object.entries(out.ttl).every(([k,v])=>k==='60000'?v.ok!==undefined:v.refused==='invalid'),expiredRefused:out.expired.settle.refused==='stale'&&out.expired.renew.refused==='stale'};
}
if(section==='skew'){
 const holder=L.nonce();await acquire(holder,60000);
 const skew=`const real=Date.now.bind(Date);Date.now=()=>real()+3600000;`,pre=L.directory+'rawcapture/.iv-skew.mjs';writeFileSync(pre,skew);
 const t0=Date.now(),r=await L.reconcile(undefined,{NODE_OPTIONS:'--import '+pre});rmSync(pre);
 out.skewedReconciler={exit:r.exit,err:r.err,waitedMs:Date.now()-t0};await release(holder);
 out.verdict={refusedWhileHeld:r.exit!==0&&/leased/.test(r.err)};
}
const orig=readFileSync(L.directory+'rawcapture/reconcile.mjs','utf8'),tmp=L.directory+'rawcapture/.iv-lease/';
const variant=(name,edits)=>{mkdirSync(tmp,{recursive:true});let s=orig.replaceAll("'../tenants/api.mjs'","'../../tenants/api.mjs'").replaceAll("'./runtime.mjs'","'../runtime.mjs'");for(const [a,b] of edits){if(!s.includes(a))throw Error('anchor '+a);s=s.replace(a,b);}const p=tmp+name+'.mjs';writeFileSync(p,s);return p;};
const RENEW="await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});\n     const r=api(tenant,'/contacts/new','POST',{email:c.email});";
if(section==='stall'){
 const email='iv-stall-'+L.run+'@example.invalid';await L.postA([{email,firstname:'Stall suggestion'}]);
 // Instrumentation only: print a marker right after the renew that precedes create.
 const p=variant('marker',[[RENEW,"await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});process.stderr.write('RENEWED '+c.email+'\\n');await sleep(200);\n     const r=api(tenant,'/contacts/new','POST',{email:c.email});"]]);
 let child;const stalled=new Promise(res=>{child=spawn(process.execPath,[p,'a']);let e='',o='';child.stdout.on('data',d=>o+=d);child.stderr.on('data',d=>{e+=d;if(e.includes('RENEWED '+email)&&!child.stopped){child.stopped=true;child.kill('SIGSTOP');res();}});child.on('close',c=>{child.result={exit:c,err:(e.match(/Raw capture capture:\w+ refused: \w+|Error: [^\n]*/)?.[0]??'').slice(0,200),out:o.trim().slice(0,400)};});});
 await stalled;const stoppedAt=Date.now();
 const second=await L.reconcile();const secondDone=Date.now();
 await new Promise(r=>setTimeout(r,Math.max(0,20000-(Date.now()-stoppedAt))));child.kill('SIGCONT');
 await new Promise(r=>{const w=setInterval(()=>{if(child.result){clearInterval(w);r();}},100);});
 const cap=(await L.inventory('a')).find(c=>c.email===email);
 Object.assign(out,{email,second:{exit:second.exit,err:second.err,afterMs:secondDone-stoppedAt,log:second.log?.filter(x=>x.capture===cap?.id)},stalled:child.result,contacts:L.withEmail('a',email),capture:{status:cap?.status,outcome:cap?.outcome,contactId:cap?.contactId}});
 out.verdict={oneContact:out.contacts.length===1,settledOnce:cap?.status==='settled',stalledFenced:child.result.exit!==0&&/stale/.test(child.result.err)};
}
if(section==='barrier'){
 const email='iv-barrier-'+L.run+'@example.invalid';await L.postA([{email,firstname:'Barrier suggestion'}]);
 const at=Date.now()+22000;
 // Timing only: each copy waits until the same wall-clock instant just before calling create. The first holds the
 // lease until it lapses (15 s); the second acquires it after expiry and then waits for the same instant.
 const p=variant('barrier',[[RENEW,"await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});await sleep(Math.max(0,Number(process.env.IV_AT)-Date.now()));\n     const r=api(tenant,'/contacts/new','POST',{email:c.email});"]]);
 const first=L.reconcile(p,{IV_AT:String(at)});await new Promise(r=>setTimeout(r,2000));const second=L.reconcile(p,{IV_AT:String(at)});
 const [a,b]=await Promise.all([first,second]);
 const cap=(await L.inventory('a')).find(c=>c.email===email);
 Object.assign(out,{email,reconcilers:[a,b].map(x=>({exit:x.exit,err:x.err})),contacts:L.withEmail('a',email),capture:{status:cap?.status,outcome:cap?.outcome,contactId:cap?.contactId}});
 out.verdict={duplicateContacts:out.contacts.length>1,oneFenced:[a,b].some(x=>/stale/.test(x.err))};
 if(cap?.status==='pending'){const r=await L.reconcile();out.cleanup={exit:r.exit,capture:(await L.inventory('a')).find(c=>c.email===email)?.outcome};}
}
rmSync(tmp,{recursive:true,force:true});
L.save3('c5-lease-'+section,out);console.log(JSON.stringify(out,null,0).slice(0,2500));
