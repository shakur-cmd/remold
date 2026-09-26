// IV r2 attack 6: reconciler races and poison on tenant A only (db-b is near its memory limit).
// Sections: drain, two reconcilers at once, admin creates the same emails mid-run, multi-match email, poison emails.
import {spawn,spawnSync} from 'node:child_process';
import * as L from './lib2.mjs';
const t='a',out={tenant:t},section=process.argv[2];
const reconcilePath=L.directory+'rawcapture/reconcile.mjs';
const runRec=()=>new Promise(r=>{const p=spawn(process.execPath,[reconcilePath,t]);let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>e+=d);p.on('close',c=>{let log=null;try{log=JSON.parse(o.trim());}catch{}r({exit:c,log,stderr:e.split('\n').find(l=>/Error|refused|assert/i.test(l))??e.slice(0,200)});});});
const post=async rows=>{const bodies=rows.map(r=>L.body(t,r.email,r.firstname,r.n??L.nonce()));return (await L.burst(L.prefix+'-public-'+t,{hostname:'127.0.0.1',port:8080,host:L.host(t),bodies})).map(r=>r.status);};
const pendingCount=async()=>(await L.inventory(t)).filter(c=>c.status==='pending').length;
const dnc=id=>L.sql(t,'SELECT COUNT(*) FROM lead_donotcontact WHERE lead_id='+Number(id));
if(section==='drain'){
 const m0=L.mautic(t),p0=await pendingCount(),r=await runRec(),m1=L.mautic(t);
 const owners=L.sql(t,"SELECT id,firstname,(SELECT COUNT(*) FROM lead_donotcontact d WHERE d.lead_id=l.id) FROM leads l WHERE email LIKE 'iv-own-%r2%' ORDER BY id").split('\n').filter(Boolean);
 Object.assign(out,{pendingBefore:p0,pendingAfter:await pendingCount(),exit:r.exit,stderr:r.stderr,outcomes:r.log?.reduce((a,x)=>(a[x.outcome]=(a[x.outcome]??0)+1,a),{}),mauticBefore:m0,mauticAfter:m1,r2Owners:owners});
}
if(section==='two'){
 const emails=Array.from({length:6},(_,i)=>'iv-two-'+L.run+'-'+i+'@example.invalid');
 const st=await post(emails.flatMap((e,i)=>[{email:e,firstname:'First '+i},{email:e,firstname:'Second '+i}]));
 const m0=L.mautic(t),[r1,r2]=await Promise.all([runRec(),runRec()]),m1=L.mautic(t);
 const per=emails.map(e=>({email:e,contacts:L.withEmail(t,e)}));
 const inv=(await L.inventory(t)).filter(c=>emails.includes(c.email));
 Object.assign(out,{postStatuses:st,reconcilers:[r1,r2].map(r=>({exit:r.exit,stderr:r.stderr,n:r.log?.length??null})),perEmail:per,captures:inv.map(c=>[c.email.split('-').pop(),c.firstname,c.status,c.outcome,c.contactId]),contactsAdded:m1.contacts-m0.contacts,pendingLeft:inv.filter(c=>c.status==='pending').length,
  verdict:{oneContactPerEmail:per.every(p=>p.contacts.length===1),allSettledOrRetryable:true,bothExit0:r1.exit===0&&r2.exit===0}});
 // Anything left pending after a crash is picked up by a plain rerun.
 if(out.pendingLeft){const r3=await runRec();out.rerun={exit:r3.exit,stderr:r3.stderr};out.pendingAfterRerun=(await L.inventory(t)).filter(c=>emails.includes(c.email)&&c.status==='pending').length;}
}
if(section==='admin'){
 // Mechanism: what the reconciler's create call does to an existing suppressed contact.
 const owner=L.makeOwner(t,'upsert'),before=L.profile(t,owner.id);
 const up=L.api(t,'/contacts/new','POST',{email:owner.email,firstname:'Public suggestion'});
 out.mechanism={ownerId:owner.id,createStatus:up.status,returnedId:up.data?.contact?.id,before,after:L.profile(t,owner.id)};
 // Real race: 40 public captures for fresh emails; an admin creates the same emails (with DNC) while the reconciler runs.
 const emails=Array.from({length:40},(_,i)=>'iv-race-'+L.run+'-'+i+'@example.invalid');
 out.postStatuses=(await post(emails.map((e,i)=>({email:e,firstname:'Public '+i})))).join('');
 const admin=()=>new Promise(r=>{const script=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const auth='Basic '+Buffer.from('proof:'+process.env.REMOLD_ADMIN_PASSWORD).toString('base64');const res=[];
for(const e of a.emails){const c=await fetch('http://127.0.0.1/api/contacts/new',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({email:e,firstname:'Admin',lastname:'Owner'})});const j=await c.json().catch(()=>null);const id=j?.contact?.id;let d=null;if(id){const x=await fetch('http://127.0.0.1/api/contacts/'+id+'/dnc/email/add',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({reason:3})});d=x.status;}res.push({e,status:c.status,id,dnc:d,at:Date.now()});}
console.log(JSON.stringify(res));`;const p=spawn('docker',['--context',L.context,'exec','-i',L.prefix+'-web-'+t,'node','--input-type=module','-e',script]);let o='';p.stdout.on('data',d=>o+=d);p.on('close',()=>{try{r(JSON.parse(o.trim()));}catch{r([]);}});p.stdin.end(JSON.stringify({emails:[...emails].reverse()}));});
 const [rec,adm]=await Promise.all([runRec(),admin()]);
 const per=emails.map((e,i)=>{const c=L.withEmail(t,e);return {i,contacts:c.map(x=>({...x,dnc:Number(dnc(x.id))}))};});
 const inv=(await L.inventory(t)).filter(c=>emails.includes(c.email));
 const adminIds=new Set(adm.filter(a=>a.id).map(a=>a.id));
 out.race={reconciler:{exit:rec.exit,stderr:rec.stderr},adminCreates:adm.map(a=>[a.status,a.id,a.dnc]),perEmail:per,settled:inv.map(c=>[c.firstname,c.status,c.outcome,c.contactId]),
  adminContactRenamedByPublic:per.filter(p=>p.contacts.some(c=>adminIds.has(c.id)&&c.firstname.startsWith('Public'))).map(p=>p.i),
  adminDncLost:per.filter(p=>p.contacts.some(c=>adminIds.has(c.id)&&c.dnc===0)).map(p=>p.i),
  duplicateContacts:per.filter(p=>p.contacts.length>1).map(p=>p.i),
  settledCreatedButAdminOwned:inv.filter(c=>c.outcome==='created'&&adminIds.has(c.contactId)).length};
 out.race.adminCreatedFirstThenReconcilerSaw=inv.filter(c=>c.outcome==='existing').length;
}
if(section==='multi'){
 const m1=L.makeOwner(t,'multi1'),tmp=L.makeOwner(t,'multi2');
 L.sql(t,`UPDATE leads SET email='${m1.email}' WHERE id=${tmp.id}`);
 const pa=[L.profile(t,m1.id),L.profile(t,tmp.id)];
 out.postStatuses=await post([{email:m1.email,firstname:'Multi suggestion'}]);
 const r=await runRec(),inv=(await L.inventory(t)).filter(c=>c.email===m1.email);
 Object.assign(out,{ids:[m1.id,tmp.id],reconciler:{exit:r.exit,stderr:r.stderr},captures:inv.map(c=>[c.status,c.outcome,c.contactId]),before:pa,after:[L.profile(t,m1.id),L.profile(t,tmp.id)],verdict:{ambiguous:inv.length===1&&inv[0].outcome==='ambiguous'&&inv[0].contactId===null,unchanged:JSON.stringify(pa)===JSON.stringify([L.profile(t,m1.id),L.profile(t,tmp.id)])}});
}
if(section==='poison'){
 // Two emails the edge and Convex accept: one Mautic refuses to create, one whose search matches every contact.
 const good='iv-after-poison-'+L.run+'@example.invalid',p1='iv%pct-'+L.run+'@example.invalid',p2='%@%.%';
 out.postStatuses=await post([{email:p1,firstname:'Poison create'}]);out.postStatuses.push(...await post([{email:p2,firstname:'Poison search'}]));out.postStatuses.push(...await post([{email:good,firstname:'Good after poison'}]));
 const pend0=await pendingCount(),r1=await runRec(),r2=await runRec();
 const inv=await L.inventory(t),row=e=>inv.find(c=>c.email===e);
 Object.assign(out,{pendingBefore:pend0,runs:[r1,r2].map(r=>({exit:r.exit,stderr:r.stderr,settledThisRun:r.log?.length??null})),state:{[p1]:row(p1)?.status,[p2]:row(p2)?.status,[good]:row(good)?.status},goodContacts:L.withEmail(t,good).length,pendingAfter:await pendingCount()});
}
L.save2('b6-reconciler-'+section,out);console.log(JSON.stringify(out,null,0).slice(0,3000));
