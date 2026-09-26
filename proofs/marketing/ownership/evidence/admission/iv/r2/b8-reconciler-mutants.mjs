// IV r2 reconciler mutants and the lookup-then-create window, tenant A only. Each variant is a temp copy of
// rawcapture/reconcile.mjs run on the host against the live capture store and Mautic A.
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import * as L from './lib2.mjs';
const t='a',orig=readFileSync(L.directory+'rawcapture/reconcile.mjs','utf8'),tmp=L.directory+'rawcapture/.iv-mut/';
mkdirSync(tmp,{recursive:true});
const variant=(name,from,to)=>{if(from&&!orig.includes(from))throw Error('anchor missing '+name);const p=tmp+name+'.mjs';writeFileSync(p,from?orig.replace(from,to).replaceAll("'../tenants/api.mjs'","'../../tenants/api.mjs'").replaceAll("'./runtime.mjs'","'../runtime.mjs'"):orig.replaceAll("'../tenants/api.mjs'","'../../tenants/api.mjs'").replaceAll("'./runtime.mjs'","'../runtime.mjs'"));return p;};
const run=(p,env={})=>new Promise(r=>{const c=spawn(process.execPath,[p,t],{env:{...process.env,...env}});let o='',e='';c.stdout.on('data',d=>o+=d);c.stderr.on('data',d=>e+=d);c.on('close',x=>{let log=null;try{log=JSON.parse(o.trim());}catch{}r({exit:x,log,err:(e.split('\n').find(l=>/Error/.test(l))??'').slice(0,160)});});});
const post=async rows=>(await L.burst(L.prefix+'-public-'+t,{hostname:'127.0.0.1',port:8080,host:L.host(t),bodies:rows.map(r=>L.body(t,r.email,r.firstname,L.nonce()))})).map(r=>r.status);
const out={};
// Drain anything pending first with the original so each case starts clean.
out.drain=await run(variant('orig'));out.drain.log=out.drain.log?.length;
// R1: case-insensitive email comparison removed. Capture = owner email in upper case.
{const owner=L.makeOwner(t,'r1case'),p0=L.profile(t,owner.id);await post([{email:owner.email.toUpperCase(),firstname:'Upper-case public suggestion'}]);
 const r=await run(variant('r1',"String(c.fields.all.email??'').toLowerCase()===email.toLowerCase()","String(c.fields.all.email??'')===email"));
 out.R1={mutant:'case-insensitive match removed',exit:r.exit,err:r.err,outcomes:r.log?.map(x=>[x.outcome,x.contactId]),ownerBefore:p0,ownerAfter:L.profile(t,owner.id),contactsWithEmail:L.withEmail(t,owner.email)};
 out.R1.killed=JSON.stringify(p0)!==JSON.stringify(out.R1.ownerAfter);}
// R1 control with the original: same attack, owner untouched.
{const owner=L.makeOwner(t,'r1ctl'),p0=L.profile(t,owner.id);await post([{email:owner.email.toUpperCase(),firstname:'Upper-case public suggestion'}]);
 const r=await run(variant('orig2'));out.R1control={exit:r.exit,outcomes:r.log?.map(x=>[x.outcome,x.contactId]),ownerUnchanged:JSON.stringify(p0)===JSON.stringify(L.profile(t,owner.id)),ownerId:owner.id};}
// R2: multi-match treated as the first match.
{const m1=L.makeOwner(t,'r2multi1'),m2=L.makeOwner(t,'r2multi2');L.sql(t,`UPDATE leads SET email='${m1.email}' WHERE id=${m2.id}`);
 await post([{email:m1.email,firstname:'Multi'}]);const r=await run(variant('r2',"if(matches.length>1)outcome='ambiguous';","if(false)outcome='ambiguous';"));
 out.R2={mutant:'ambiguous branch removed',exit:r.exit,err:r.err,outcomes:r.log?.map(x=>[x.outcome,x.contactId]),ids:[m1.id,m2.id]};out.R2.killed=!!r.log?.some(x=>x.outcome!=='ambiguous');}
// R3: search-size guard removed, with the poison email that matches every contact.
{await post([{email:'%@%.%',firstname:'Poison search R3'}]);const r=await run(variant('r3',"assert.ok(Number(found.total)<100,'Do not truncate the email match set');",""));
 out.R3={mutant:'search-size guard removed',exit:r.exit,err:r.err,outcomes:r.log?.map(x=>[x.outcome,x.contactId]),contactsWithPoisonEmail:L.withEmail(t,'%@%.%')};
 const left=(await L.inventory(t)).find(c=>c.status==='pending'&&c.email==='%@%.%');if(left)out.R3.manualSettle=await L.mutation('capture:settle',{key:L.K.a.reconciler,id:left.id,outcome:'ambiguous'});}
// Window: the original logic with a 4 s pause between lookup and create (timing only). An admin creates the same
// email with DNC during the pause, as a real operator could.
{const email='iv-window-'+L.run+'@example.invalid';await post([{email,firstname:'Public suggestion in window'}]);
 const p=variant('window',"contactId=ok(api(tenant,'/contacts/new'","await new Promise(r=>setTimeout(r,4000));contactId=ok(api(tenant,'/contacts/new'");
 const rec=run(p);await new Promise(r=>setTimeout(r,1500));
 const admin=L.ok(L.api(t,'/contacts/new','POST',{email,firstname:'Admin chose this',lastname:'Owner'})).contact;L.ok(L.api(t,'/contacts/'+admin.id+'/dnc/email/add','POST',{reason:3}));
 const adminBefore=L.profile(t,admin.id),r=await rec;
 out.window={exit:r.exit,err:r.err,outcomes:r.log?.map(x=>[x.outcome,x.contactId]),adminId:admin.id,adminBefore,adminAfter:L.profile(t,admin.id),contactsWithEmail:L.withEmail(t,email)};
 out.window.adminOverwritten=out.window.adminAfter.firstname!==adminBefore.firstname;out.window.dncKept=out.window.adminAfter.doNotContact.length===1;}
rmSync(tmp,{recursive:true,force:true});
out.pendingLeft=(await L.inventory(t)).filter(c=>c.status==='pending').length;
L.save2('b8-reconciler-mutants',out);console.log(JSON.stringify(out,null,0).slice(0,4000));
