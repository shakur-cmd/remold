// IV attack 5: 16 concurrent posts per tenant through the deployed edges, both tenants at once (8 existing owner,
// 8 one new email, hostile client cookie). Then the disclosed limit: two edge processes on the same form, 8+8.
import {spawn} from 'node:child_process';
import * as L from './lib.mjs';
const {admitForm}=await import('../../../../publishing/admission.mjs');
const N=Number(process.argv[2]??16);
const client=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');
const call=body=>new Promise(resolve=>{const t0=Date.now();const req=http.request({hostname:'127.0.0.1',port:8080,path:a.path,method:'POST',headers:{Host:a.host,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body),Origin:'http://'+a.host,Cookie:a.cookie}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:d,ms:Date.now()-t0}));});req.setTimeout(120000,()=>req.destroy(Error('timeout')));req.on('error',e=>resolve({status:0,body:e.message,ms:Date.now()-t0}));req.end(body);});
console.log(JSON.stringify(await Promise.all(a.rows.map(r=>call(new URLSearchParams({email:r.email,firstname:r.firstname,t:a.token}).toString())))));`;
const execAsync=(name,input)=>new Promise((resolve,reject)=>{const p=spawn('docker',['--context',L.context,'exec','-i',name,'node','--input-type=module','-e',client]);let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>e+=d);p.on('close',c=>c?reject(Error(e)):resolve(JSON.parse(o.trim())));p.stdin.end(JSON.stringify(input));});
const out={n:N,deployed:{},twoEdges:{}},prep={};
for(const t of ['a','b']){
 const owner=L.makeOwner(t,'conc'+N),newEmail='iv-new-'+L.run+'-conc@example.invalid',formId=L.deployedFormId(t);
 const rows=Array.from({length:N},(_,i)=>({email:i%2?newEmail:owner.email,firstname:'Conc '+L.run+' '+i}));
 prep[t]={owner,newEmail,formId,rows,p0:L.profile(t,owner.id),c0:L.counts(t),maxSub:Number(L.sql(t,'SELECT COALESCE(MAX(id),0) FROM form_submissions')),input:{path:'/form/'+formId,host:L.host(t),cookie:'mtc_id='+owner.id+'; Blocked-Tracking=0',token:await L.edgeToken(t),rows}};
}
const t0=Date.now(),[ra,rb]=await Promise.all(['a','b'].map(t=>execAsync(L.prefix+'-public-'+t,prep[t].input)));const wall=Date.now()-t0;
for(const [t,res] of [['a',ra],['b',rb]]){
 const P=prep[t],p1=L.profile(t,P.owner.id),c1=L.counts(t);
 const subs=L.sql(t,`SELECT id,COALESCE(lead_id,'null') FROM form_submissions WHERE id>${P.maxSub} AND form_id=${P.formId} ORDER BY id`).split('\n').filter(Boolean);
 const newContacts=L.sql(t,`SELECT COUNT(*) FROM leads WHERE email='${P.newEmail}'`);
 out.deployed[t]={formId:P.formId,ownerId:P.owner.id,statuses:res.map(r=>r.status),ms:res.map(r=>r.ms),submissions:subs,ownerBefore:P.p0,ownerAfter:p1,countersBefore:P.c0,countersAfter:c1,newEmailContacts:Number(newContacts),
  verdict:{allAccepted:res.every(r=>r.status===200),capturedEqualsAccepted:subs.length===res.filter(r=>r.status===200).length,allUnlinked:subs.every(s=>s.endsWith('\tnull')),ownerUnchanged:JSON.stringify(P.p0)===JSON.stringify(p1),noContacts:c1.contacts===P.c0.contacts&&c1.anonymousContacts===P.c0.anonymousContacts&&Number(newContacts)===0}};
 console.log('deployed',t,JSON.stringify(out.deployed[t].verdict),'maxms',Math.max(...res.map(r=>r.ms)),'wall',wall);
}
// Two edge processes (committed server.mjs, in-process copies) on the same admitted form, 8+8 at once, on A.
for(const t of ['a']){
 const formId=L.deployedFormId(t),{form,admission}=admitForm(t,formId),owner=L.makeOwner(t,'twoedge'),p0=L.profile(t,owner.id),c0=L.counts(t),maxSub=Number(L.sql(t,'SELECT COALESCE(MAX(id),0) FROM form_submissions'));
 const rows=Array.from({length:N},(_,i)=>({email:i%2?'iv-new-'+L.run+'-twoedge@example.invalid':owner.email,firstname:'Two edge '+i}));
 const res=L.probeEdge(t,{form:L.edgeFormConfig(form),admission,rows,clientCookie:'Blocked-Tracking=0',extraEdges:1});
 const p1=L.profile(t,owner.id),c1=L.counts(t),subs=L.sql(t,`SELECT id,COALESCE(lead_id,'null') FROM form_submissions WHERE id>${maxSub} AND form_id=${formId} ORDER BY id`).split('\n').filter(Boolean);
 out.twoEdges[t]={statuses:res.map(r=>r.status),submissions:subs,ownerUnchanged:JSON.stringify(p0)===JSON.stringify(p1),countersBefore:c0,countersAfter:c1};
 console.log('twoEdges',t,JSON.stringify(res.map(r=>r.status)),subs.length,out.twoEdges[t].ownerUnchanged,c0.contacts,c1.contacts);
}
L.save('a5-concurrency-'+N,out);
