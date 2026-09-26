// SERVICE proof for raw capture through the deployed public edges. One-shot per label; evidence is always written.
// Phases: D1 edit on the old native intake forms, 16 concurrent posts per tenant (both tenants at once), a lost
// response after commit followed by a client retry, direct tenant-binding refusals, then reconcile with a crash.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {directory,context,prefix,docker} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {keys,query,mutation} from './runtime.mjs';
import {probe} from './races.mjs';
const label=process.argv[2];assert.match(label??'',/^[a-zA-Z0-9_-]+$/);
const outDir=directory+'ownership/evidence/raw-capture/',output=outDir+label+'.json';assert.ok(!existsSync(output),'One-shot: use a new label');mkdirSync(outDir,{recursive:true});
const fx=randomUUID().slice(0,8),K=keys(),hosts={a:'tenant-a.marketing-proof.invalid',b:'tenant-b.marketing-proof.invalid'};
// REMOLD_REPLAY_TENANTS=a runs with no writes to tenant B at all (db-b sits near its memory limit); B is then only read.
const T=(process.env.REMOLD_REPLAY_TENANTS??'a,b').split(',');if(!T.length||T.some(t=>!['a','b'].includes(t))||new Set(T).size!==T.length)throw Error('REMOLD_REPLAY_TENANTS must be a, b or a,b');
const evidence={label,tenants:T,fixture:fx,startedAt:new Date().toISOString(),level:'SERVICE isolated local containers; synthetic data; no mail, DNS, TLS, provider or host port beyond the loopback forward',checks:[]};
const check=(ok,name,detail)=>{evidence.checks.push({ok:!!ok,name,...(detail===undefined?{}:{detail})});};
const ok=r=>{assert.ok(r.status>=200&&r.status<300,'Mautic API refused '+r.status);return r.data;};
const sql=(t,q)=>docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
const mautic=t=>{const k=['formSubmissions','contacts','anonymousContacts','dnc','campaignLeads','queuedEmails','emailStats'];const v=sql(t,'SELECT (SELECT COUNT(*) FROM form_submissions),(SELECT COUNT(*) FROM leads),(SELECT COUNT(*) FROM leads WHERE email IS NULL),(SELECT COUNT(*) FROM lead_donotcontact),(SELECT COUNT(*) FROM campaign_leads),(SELECT COUNT(*) FROM messenger_messages),(SELECT COUNT(*) FROM email_stats)').split('\t').map(Number);return Object.fromEntries(k.map((x,i)=>[x,v[i]]));};
const profile=(t,id)=>{const c=ok(api(t,'/contacts/'+id)).contact;return {id:c.id,firstname:c.fields.all.firstname,lastname:c.fields.all.lastname,email:c.fields.all.email,points:c.points,doNotContact:c.doNotContact.map(d=>({channel:d.channel,reason:d.reason}))};};
const withEmail=(t,email)=>sql(t,`SELECT id,COALESCE(firstname,'') FROM leads WHERE email='${email.replace(/[^a-z0-9@.-]/g,'')}' ORDER BY id`).split('\n').filter(Boolean).map(l=>{const [id,firstname]=l.split('\t');return {id:Number(id),firstname};});
const inventory=t=>query('capture:inventory',{key:K[t].reconciler});
const exec=promisify(execFile);
async function inContainer(t,script,input){const child=exec('docker',['--context',context,'exec','-i',prefix+'-public-'+t,'node','--input-type=module','-e',script],{maxBuffer:1<<24});child.child.stdin.end(JSON.stringify(input));return JSON.parse((await child).stdout.trim().split('\n').pop());}
// Browser-like clients inside the tenant's edge container: GET the form for token and nonce, then POST all at once.
const postScript=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');
const call=(method,body,headers={})=>new Promise(resolve=>{const req=http.request({hostname:'127.0.0.1',port:8080,path:'/form/intake',method,headers:{Host:a.host,...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},res=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(c).toString()}));});req.setTimeout(20000,()=>req.destroy(Error('timeout')));req.on('error',e=>resolve({status:0,body:e.message}));req.end(body);});
const pages=await Promise.all(a.rows.map(()=>call('GET')));const forms=pages.map(p=>({t:p.body.match(/name="t" value="([a-f0-9]{64})"/)[1],n:p.body.match(/name="n" value="([a-f0-9]{32})"/)[1]}));
const out=await Promise.all(a.rows.map((r,i)=>call('POST',new URLSearchParams({email:r.email,firstname:r.firstname,t:forms[i].t,n:forms[i].n}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:'http://'+a.host,Cookie:a.cookie})));
console.log(JSON.stringify(out.map((r,i)=>({...r,n:forms[i].n}))));`;
// A second edge instance (same deployed source, config and keys) whose capture store sits behind a proxy that lets
// the first mutation commit, then drops the connection before the edge sees the reply. The client then retries.
const retryScript=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');const fs=await import('node:fs');
const mod=await import('data:text/javascript;base64,'+fs.readFileSync('/public-server.mjs').toString('base64'));const config=JSON.parse(fs.readFileSync('/public-config.json'));
let seen=0;const proxy=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const up=http.request({hostname:'capture',port:3210,path:req.url,method:req.method,headers:req.headers},r=>{const b=[];r.on('data',c=>b.push(c));r.on('end',()=>{if(++seen===1){req.socket.destroy();return;}res.writeHead(r.statusCode,r.headers);res.end(Buffer.concat(b));});});up.end(Buffer.concat(chunks));});});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const edge=mod.createPublicServer({...config,capture:{...config.capture,url:'http://127.0.0.1:'+proxy.address().port}});await new Promise(r=>edge.listen(0,'127.0.0.1',r));
const call=(method,body)=>new Promise(resolve=>{const req=http.request({hostname:'127.0.0.1',port:edge.address().port,path:'/form/intake',method,headers:{Host:config.host,...(body?{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}:{})}},res=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(c).toString()}));});req.on('error',e=>resolve({status:0,body:e.message}));req.end(body);});
const page=(await call('GET')).body,body=new URLSearchParams({email:a.email,firstname:a.firstname,t:page.match(/name="t" value="([a-f0-9]{64})"/)[1],n:page.match(/name="n" value="([a-f0-9]{32})"/)[1]}).toString();
const first=await call('POST',body),retry=await call('POST',body),changed=await call('POST',body.replace(/firstname=[^&]*/,'firstname=Changed'));edge.close();proxy.close();
console.log(JSON.stringify({first,retry,changed,n:new URLSearchParams(body).get('n'),mutationsSeenByProxy:seen}));`;
const phase=async(name,fn)=>{try{await fn();}catch(e){check(false,name+' threw',String(e.message).slice(0,300));throw e;}};
const fixtures=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')),state={};
try{
 const base={};for(const t of T){base[t]=mautic(t);}evidence.mauticStart=base;
 evidence.edges=Object.fromEntries(T.map(t=>[t,{serverSha256:docker(['exec',prefix+'-public-'+t,'sha256sum','/public-server.mjs']).split(' ')[0]}]));
 evidence.localServerSha256=createHash('sha256').update(readFileSync(directory+'publishing/server.mjs')).digest('hex');
 check(T.every(t=>evidence.edges[t].serverSha256===evidence.localServerSha256),'deployed edges run the repository server.mjs');
 await phase('seed',async()=>{for(const t of T){
  // IV D1 edit on the native form the edge used to post to: map email and firstname, add remove-DNC.
  const formId=fixtures.tenants[t].intakeFormsId,f=ok(api(t,'/forms/'+formId)).form,field=a=>f.fields.find(x=>x.alias===a);
  ok(api(t,'/forms/'+formId+'/edit','PATCH',{fields:[{id:field('email').id,label:'Email',type:'email',alias:'email',mappedObject:'contact',mappedField:'email'},{id:field('firstname').id,label:'First name',type:'text',alias:'firstname',mappedObject:'contact',mappedField:'firstname'},{id:f.fields.find(x=>x.type==='button').id,label:'Submit',type:'button',alias:'submit'}],actions:[{name:'Remove DNC ('+fx+')',type:'lead.remove_do_not_contact',properties:{}}]}));
  const edited=ok(api(t,'/forms/'+formId)).form;state[t]={formId,editedForm:{mapped:edited.fields.filter(x=>x.mappedField).map(x=>x.alias),actions:Object.values(edited.actions).map(a=>a.type)}};
  const email='own-'+t+'-'+fx+'@example.invalid',owner=ok(api(t,'/contacts/new','POST',{email,firstname:'Owner '+t,lastname:'Stable '+t})).contact;
  ok(api(t,'/contacts/'+owner.id+'/dnc/email/add','POST',{reason:3,comments:'Raw capture proof'}));
  Object.assign(state[t],{ownerId:owner.id,ownerEmail:email,newEmail:'new-'+t+'-'+fx+'@example.invalid',ownerBefore:profile(t,owner.id),inventoryBefore:(await inventory(t)).length});
 }});
 evidence.d1Edit=Object.fromEntries(T.map(t=>[t,{formId:state[t].formId,...state[t].editedForm}]));
 const afterSeed={};for(const t of T)afterSeed[t]=mautic(t);evidence.mauticAfterSeed=afterSeed;
 await phase('concurrent posts',async()=>{
  const rows=t=>Array.from({length:16},(_,i)=>i<8?{email:state[t].ownerEmail,firstname:'Suggested existing '+i}:{email:state[t].newEmail,firstname:'Suggested new '+i});
  const results=await Promise.all(T.map(t=>inContainer(t,postScript,{host:hosts[t],rows:rows(t),cookie:'mtc_id='+state[t].ownerId+'; Blocked-Tracking=0'})));
  for(const [i,t] of T.entries()){
   const r=results[i],inv=await inventory(t),mine=inv.filter(c=>r.some(x=>x.n===c.idempotencyKey));state[t].nonces=r.map(x=>x.n);
   evidence['posts-'+t]={statuses:r.map(x=>x.status),stored:mine.length,inventoryTotal:inv.length};
   check(r.every(x=>x.status===200),t+': all 16 concurrent posts acknowledged',r.map(x=>x.status).join(','));
   check(mine.length===16&&mine.every(c=>c.tenant===t&&c.status==='pending'),t+': exactly 16 captures stored under tenant '+t,mine.length);
   check(inv.length===state[t].inventoryBefore+16,t+': no other captures appeared',[state[t].inventoryBefore,inv.length]);
  }
  if(T.length===2)for(const t of T){const other=T.find(x=>x!==t),inv=await inventory(t);check(!inv.some(c=>c.email.includes('-'+other+'-')),t+': inventory holds none of tenant '+other+' captures');}
 });
 await phase('lost response retry',async()=>{for(const t of T){
  const r=await inContainer(t,retryScript,{email:state[t].newEmail,firstname:'Retry '+t});state[t].nonces.push(r.n);const got=(await inventory(t)).filter(c=>c.idempotencyKey===r.n);
  evidence['retry-'+t]={first:r.first.status,retry:r.retry.status,changedValues:r.changed.status,storedForNonce:got.length,mutationsSeenByProxy:r.mutationsSeenByProxy};
  check(r.first.status===502&&r.retry.status===200,t+': first reply lost after commit (502), client retry acknowledged (200)',[r.first.status,r.retry.status]);
  check(got.length===1&&got[0].firstname==='Retry '+t,t+': exactly one capture for the retried nonce',got.length);
  check(r.changed.status===409,t+': same nonce with changed values refused as conflict',r.changed.status);
 }});
 await phase('tenant binding',async()=>{
  // With B in the run, use one of this run's B captures; otherwise any existing B capture (read only).
  const bInv=await inventory('b'),bCapture=T.includes('b')?bInv.find(c=>c.idempotencyKey===state.b.nonces[0]):bInv[0],bStatus=bCapture.status;
  // A holds its own live lease, so a refusal here can only come from tenant scope.
  const lease=randomUUID().replaceAll('-','');await mutation('capture:acquire',{key:K.a.reconciler,token:lease,ttlMs:20000});
  const expect={'reconciler A settles a B capture':'scope','edge A key reads pending':'credential','reconciler A key writes a capture':'credential','unknown key':'credential'};
  const tries={'reconciler A settles a B capture':()=>mutation('capture:settle',{key:K.a.reconciler,lease,id:bCapture.id,outcome:'existing',contactId:1}),'edge A key reads pending':()=>query('capture:pending',{key:K.a.edge,limit:1}),'reconciler A key writes a capture':()=>mutation('capture:capture',{key:K.a.reconciler,idempotencyKey:'f'.repeat(32),email:'x@example.invalid',firstname:''}),'unknown key':()=>query('capture:inventory',{key:'e'.repeat(64)})};
  evidence.tenantRefusals={};for(const [name,fn] of Object.entries(tries)){let code=null;try{await fn();}catch(e){code=e.code??e.message;}evidence.tenantRefusals[name]=code;check(code===expect[name],'refused ('+expect[name]+'): '+name,code);}
  await mutation('capture:release',{key:K.a.reconciler,token:lease});
  check((await inventory('b')).find(c=>c.id===bCapture.id).status===bStatus,'B capture untouched by A credentials');
 });
 // Store refusals with no Mautic call: input validation, no re-settle, lease exclusivity and fencing (tenant A lease only).
 await phase('store probe',async()=>{for(const c of await probe())check(c.ok,'store: '+c.name,c.detail);});
 const beforeReconcile={};for(const t of T)beforeReconcile[t]=mautic(t);evidence.mauticBeforeReconcile=beforeReconcile;
 for(const t of T)check(JSON.stringify(beforeReconcile[t])===JSON.stringify(afterSeed[t]),t+': Mautic untouched by every public post (form submissions '+afterSeed[t].formSubmissions+' to '+beforeReconcile[t].formSubmissions+')',{afterSeed:afterSeed[t],beforeReconcile:beforeReconcile[t]});
 for(const t of T)check(JSON.stringify(profile(t,state[t].ownerId))===JSON.stringify(state[t].ownerBefore),t+': owner unchanged after public posts with the D1 edit live');
 await phase('reconcile',async()=>{
  const run=(t,crash)=>spawnSync(process.execPath,[directory+'rawcapture/reconcile.mjs',t],{encoding:'utf8',env:{...process.env,...(crash?{REMOLD_RECONCILE_CRASH_AFTER_CREATE:'1'}:{})}});
  const crash=run('a',true);evidence.reconcileCrashA={exit:crash.status,stderr:crash.stderr.slice(0,300)};check(crash.status===86,'a: reconciler crashed after its first create, before settle',crash.status);
  const bWhileA=mautic('b'),bPendingBefore=(await inventory('b')).filter(c=>c.status==='pending').length;
  const a1=run('a',false);evidence.reconcileA={exit:a1.status,stderr:a1.stderr.slice(0,300),log:a1.status===0?JSON.parse(a1.stdout):null};check(a1.status===0,'a: reconciler restart completed',a1.stderr.slice(0,200));
  check(JSON.stringify(mautic('b'))===JSON.stringify(bWhileA)&&(await inventory('b')).filter(c=>c.status==='pending').length===bPendingBefore&&(!T.includes('b')||(await inventory('b')).filter(c=>c.status==='pending'&&state.b.nonces.includes(c.idempotencyKey)).length===17),'b: untouched while a reconciled');
  if(T.includes('b')){const b1=run('b',false);evidence.reconcileB={exit:b1.status,stderr:b1.stderr.slice(0,300),log:b1.status===0?JSON.parse(b1.stdout):null};check(b1.status===0,'b: reconciler completed',b1.stderr.slice(0,200));}
  const after={};for(const t of T)after[t]=mautic(t);
  const again=T.map(t=>run(t,false));evidence.reconcileAgain=again.map(r=>({exit:r.status,out:r.stdout.trim()}));
  check(again.every(r=>r.status===0&&r.stdout.trim()==='[]'),'third run finds nothing pending on either tenant');
  evidence.mauticEnd={};for(const t of T){
   const end=evidence.mauticEnd[t]=mautic(t),inv=(await inventory(t)).filter(c=>state[t].nonces.includes(c.idempotencyKey)),created=withEmail(t,state[t].newEmail);
   check(JSON.stringify(end)===JSON.stringify(after[t]),t+': repeat reconcile made no Mautic change');
   check(end.formSubmissions===base[t].formSubmissions,t+': Mautic form submissions unchanged for the whole run',[base[t].formSubmissions,end.formSubmissions]);
   check(end.contacts===beforeReconcile[t].contacts+1&&end.anonymousContacts===beforeReconcile[t].anonymousContacts,t+': reconcile created exactly one contact (the new email), no anonymous contacts',[beforeReconcile[t].contacts,end.contacts]);
   check(created.length===1&&/^Suggested new |^Retry /.test(created[0].firstname),t+': one contact for the new email, started from a suggestion',created);
   check(end.dnc===beforeReconcile[t].dnc&&end.campaignLeads===beforeReconcile[t].campaignLeads&&end.queuedEmails===beforeReconcile[t].queuedEmails&&end.emailStats===beforeReconcile[t].emailStats,t+': DNC, campaign, queue and mail counters unchanged by reconcile');
   check(JSON.stringify(profile(t,state[t].ownerId))===JSON.stringify(state[t].ownerBefore),t+': existing owner profile and DNC never overwritten',profile(t,state[t].ownerId));
   check(inv.length===17&&inv.every(c=>c.status==='settled'&&c.contactId===(c.email===state[t].ownerEmail?state[t].ownerId:created[0]?.id)),t+': all 17 captures settled once, to the owner or the new contact',inv.map(c=>[c.outcome,c.contactId]));
  }
 });
}catch(e){evidence.error=String(e.stack??e).slice(0,1000);}
finally{
 // Revert the D1 edit so the old native form is back to unmapped and action-free.
 for(const t of T)if(state[t]?.formId){try{const f=ok(api(t,'/forms/'+state[t].formId)).form,ids=Object.values(f.actions??{}).map(a=>a.id);if(ids.length)api(t,'/forms/'+state[t].formId+'/actions/delete?'+ids.map(i=>'actions[]='+i).join('&'),'DELETE');
  api(t,'/forms/'+state[t].formId+'/edit','PATCH',{fields:f.fields.map(x=>({id:x.id,label:x.label,type:x.type,alias:x.alias,mappedObject:null,mappedField:null}))});const r=ok(api(t,'/forms/'+state[t].formId)).form;evidence['revert-'+t]={mapped:r.fields.filter(x=>x.mappedField).length,actions:Object.values(r.actions??{}).length};}catch(e){evidence['revert-'+t]={error:e.message};}}
 evidence.finishedAt=new Date().toISOString();evidence.failed=evidence.checks.filter(c=>!c.ok).map(c=>c.name);evidence.status=evidence.error||evidence.failed.length?'FAIL':'PASS';
 writeFileSync(output,JSON.stringify(evidence,null,1)+'\n',{flag:'wx'});
 console.log(evidence.status+' '+evidence.checks.filter(c=>c.ok).length+'/'+evidence.checks.length+' checks'+(evidence.failed.length?'\nFAILED: '+evidence.failed.join('\n        '):'')+(evidence.error?'\nERROR: '+evidence.error.split('\n')[0]:''));
 process.exitCode=evidence.status==='PASS'?0:1;
}
