// IV attack 6: restart the deployed serialized edge while 16 posts are queued. The client runs in the tenant's web
// container and reaches the edge over the internal network, so the restart does not kill the client.
import {spawn,execFileSync} from 'node:child_process';
import * as L from './lib.mjs';
const t=process.argv[2]??'a',N=Number(process.argv[3]??32),formId=L.deployedFormId(t),edge=L.prefix+'-public-'+t,token=await L.edgeToken(t);
const owner=L.makeOwner(t,'restart'),p0=L.profile(t,owner.id),c0=L.counts(t),maxSub=Number(L.sql(t,'SELECT COALESCE(MAX(id),0) FROM form_submissions'));
const tag='Restart '+L.run;
const rows=Array.from({length:N},(_,i)=>({email:i%2?'iv-new-'+L.run+'-restart@example.invalid':owner.email,firstname:tag+' '+i}));
const client=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');
const call=(body,i)=>new Promise(resolve=>{const t0=Date.now();const req=http.request({hostname:a.edge,port:8080,path:a.path,method:'POST',agent:false,headers:{Host:a.host,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body),Origin:'http://'+a.host}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(!globalThis.first){globalThis.first=1;process.stderr.write('FIRST\\n');}resolve({i,status:res.statusCode,body:d,ms:Date.now()-t0});});res.on('error',e=>resolve({i,status:0,body:e.code||e.message,ms:Date.now()-t0}));});req.setTimeout(60000,()=>req.destroy(Error('timeout')));req.on('error',e=>resolve({i,status:0,body:e.code||e.message,ms:Date.now()-t0}));req.end(body);});
console.log(JSON.stringify(await Promise.all(a.rows.map((r,i)=>call(new URLSearchParams({email:r.email,firstname:r.firstname,t:a.token}).toString(),i)))));`;
const p=spawn('docker',['--context',L.context,'exec','-i',L.prefix+'-web-'+t,'node','--input-type=module','-e',client]);let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>e+=d);
const done=new Promise(r=>p.on('close',r));p.stdin.end(JSON.stringify({edge,path:'/form/'+formId,host:L.host(t),token,rows}));
await new Promise(r=>{const w=setInterval(()=>{if(e.includes('FIRST')){clearInterval(w);r();}},5);});e=e.replace('FIRST\n','');
const restartAt=new Date().toISOString();execFileSync('docker',['--context',L.context,'restart','-t','0',edge]);const restartedAt=new Date().toISOString();
await done;if(e)console.error(e);const res=JSON.parse(o.trim());
await new Promise(r=>setTimeout(r,1500));
const subs=L.sql(t,`SELECT s.id,COALESCE(s.lead_id,'null'),r.firstname FROM form_submissions s JOIN form_results_${formId}_${L.ok(L.api(t,'/forms/'+formId)).form.alias} r ON r.submission_id=s.id WHERE s.id>${maxSub} ORDER BY s.id`).split('\n').filter(Boolean).map(l=>l.split('\t'));
const p1=L.profile(t,owner.id),c1=L.counts(t);
const accepted=res.filter(r=>r.status===200).map(r=>r.i),stored=subs.map(s=>Number(s[2].split(' ').pop()));
const ambiguous=stored.filter(i=>!accepted.includes(i)),lostAccepted=accepted.filter(i=>!stored.includes(i));
// After restart the edge must still serve from its admitted config.
const after=L.rawRequests(t,[L.post(t,'/form/'+formId,L.formBody('iv-after-restart-'+L.run+'@example.invalid','After restart',token),'Origin: http://'+L.host(t)+'\r\n')])[0].statuses;
const edgeState=JSON.parse(L.docker(['inspect',edge]))[0];
const out={tenant:t,formId,restartAt,restartedAt,responses:res,storedSubmissions:subs,accepted,storedIndexes:stored,committedButNotConfirmed:ambiguous,acceptedButNotStored:lostAccepted,duplicates:stored.length-new Set(stored).size,allUnlinked:subs.every(s=>s[1]==='null'),ownerUnchanged:JSON.stringify(p0)===JSON.stringify(p1),countersBefore:c0,countersAfter:c1,postAfterRestart:after,edgeAfter:{startedAt:edgeState.State.StartedAt,running:edgeState.State.Running,serverSha256:L.docker(['exec',edge,'sha256sum','/public-server.mjs']).split(' ')[0]}};
L.save('a6-restart-midqueue-'+t+'-'+N,out);
console.log(JSON.stringify({statuses:res.map(r=>r.status+':'+r.body.slice(0,20)),accepted:accepted.length,stored:stored.length,ambiguous,lostAccepted,dups:out.duplicates,unlinked:out.allUnlinked,owner:out.ownerUnchanged,contacts:[c0.contacts,c1.contacts],anon:[c0.anonymousContacts,c1.anonymousContacts],after}));
