// Public-edge intake proof. `baseline` submits through whatever edge is deployed now.
// `after` first proves unsafe forms are refused, then publishes an admitted raw form and submits through it.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {directory,context,prefix,docker} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {nativeCounts} from '../publishing/read-effects-replay.mjs';

const [label,mode]=process.argv.slice(2);assert.match(label??'',/^[a-zA-Z0-9_-]+$/);assert.ok(['baseline','after'].includes(mode));
const privateDir=directory+'private/admission-'+label+'/',statePath=privateDir+'state.json',outputDir=directory+'ownership/evidence/admission/',output=outputDir+label+'.json';
assert.ok(!existsSync(statePath)&&!existsSync(output),'Each run is one-shot; use a new label and keep earlier evidence');
mkdirSync(privateDir,{recursive:true,mode:0o700});mkdirSync(outputDir,{recursive:true});
const state={fixture:randomUUID(),mode,tenants:{a:{},b:{}}},save=()=>writeFileSync(statePath,JSON.stringify(state),{mode:0o600});save();
const ok=r=>{assert.ok(r.status>=200&&r.status<300,'Native API refused proof request '+r.status);return r.data;};
const sql=(t,query)=>docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',query]).trim();
const memberships=t=>Number(sql(t,'SELECT COUNT(*) FROM campaign_leads'));
const profile=c=>({id:c.id,firstname:c.fields.all.firstname,lastname:c.fields.all.lastname,email:c.fields.all.email,points:c.points,doNotContact:c.doNotContact.map(d=>({channel:d.channel,reason:d.reason}))});
const hosts={a:'tenant-a.marketing-proof.invalid',b:'tenant-b.marketing-proof.invalid'};
const rawForm=(name,{mapped=false,actions=[]}={})=>({name,formType:'standalone',isPublished:true,postAction:'return',postActionProperty:'Synthetic intake received',fields:[{label:'Email',type:'email',alias:'email',isRequired:true,saveResult:true,...(mapped?{mappedObject:'contact',mappedField:'email'}:{})},{label:'First name',type:'text',alias:'firstname',saveResult:true},{label:'Submit',type:'button',alias:'submit'}],actions});
const evidence={label,mode,fixture:state.fixture,startedAt:new Date().toISOString(),level:'SERVICE isolated local Mautic A/B plus internal public edges; synthetic data; no mail, DNS, TLS or host ports',tenants:{}};
const finish=()=>{evidence.finishedAt=new Date().toISOString();writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});};

// Concurrent POSTs from inside the tenant's public edge container, as a browser would reach it. The client
// cookie tries to claim the canonical contact and to switch tracking back on; the edge must ignore both.
function edgeSubmit(t,rows,clientCookie){
 const script=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');
const call=(method,body,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:8080,path:a.path,method,headers:{Host:a.host,...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));res.on('error',reject);});req.setTimeout(15000,()=>req.destroy(Error('Timeout')));req.on('error',reject);req.end(body);});
const page=await call('GET');const token=page.body.match(/name="t" value="([a-f0-9]{64})"/)?.[1];if(!token)throw Error('No form token '+page.status);
const out=await Promise.all(a.rows.map(r=>call('POST',new URLSearchParams({email:r.email,firstname:r.firstname,t:token}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:'http://'+a.host,Cookie:a.cookie})));
console.log(JSON.stringify(out));`;
 const formId=JSON.parse(readFileSync(directory+'private/publishing/config-'+t+'.json')).form.id;
 const out=JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-public-'+t,'node','--input-type=module','-e',script],{input:JSON.stringify({host:hosts[t],path:'/form/'+formId,rows,cookie:clientCookie}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 return {formId,responses:out};
}

if(mode==='after')try{
 const {admitForm}=await import('../publishing/admission.mjs'),{createPublicServer,TRACKING_POLICY}=await import('../publishing/server.mjs');
 const edgeIdentity=t=>{const i=JSON.parse(docker(['inspect',prefix+'-public-'+t]))[0];return {id:i.Id,startedAt:i.State.StartedAt,serverSha256:docker(['exec',prefix+'-public-'+t,'sha256sum','/public-server.mjs']).split(' ')[0]};};
 evidence.refusals=[];
 for(const t of ['a','b']){
  const before=nativeCounts(t),membersBefore=memberships(t),name=k=>'Remold admission '+k+' '+state.fixture+' '+t;
  const mapped=ok(api(t,'/forms/new','POST',rawForm(name('mapped'),{mapped:true}))).form;
  const action=ok(api(t,'/forms/new','POST',rawForm(name('action'),{actions:[{name:'Remove email DNC',type:'lead.remove_do_not_contact',properties:{}}]}))).form;
  const linked=ok(api(t,'/forms/new','POST',rawForm(name('campaign')))).form;
  // Unpublished and without canvas events: it only creates the campaign_form_xref row admission must see.
  const campaign=ok(api(t,'/campaigns/new','POST',{name:name('campaign source'),isPublished:false,events:[{id:'new1',name:'noop',type:'lead.changepoints',eventType:'action',properties:{points:0}}],forms:[{id:linked.id}]})).campaign;
  Object.assign(state.tenants[t],{mappedFormId:mapped.id,actionFormId:action.id,linkedFormId:linked.id,campaignId:campaign.id});save();
  for(const [kind,id,reason] of [['existing form 1',1,/mapped field email/],['mapped',mapped.id,/mapped field email/],['action-bearing',action.id,/native actions/],['campaign-linked',linked.id,/campaign-linked/]]){
   let refused=null;try{admitForm(t,id);}catch(e){refused=e.message;}
   evidence.refusals.push({tenant:t,kind,formId:id,refused});
   assert.ok(refused,'Unsafe '+kind+' form '+id+' on '+t+' was admitted');assert.match(refused,reason);
  }
  const after=nativeCounts(t);evidence.refusals.push({tenant:t,countersBefore:before,countersAfter:after,membershipsBefore:membersBefore,membershipsAfter:memberships(t)});
  assert.deepEqual(after,before,'Refusals must happen before any native submission or contact write');assert.equal(memberships(t),membersBefore);
 }
 // Publishing with no admitted intake form falls back to form 1 and must be refused with the running edges untouched.
 const fixtures=directory+'private/publishing/fixtures.json',publish=JSON.parse(readFileSync(fixtures));
 const edgesBefore={a:edgeIdentity('a'),b:edgeIdentity('b')},withoutIntake=structuredClone(publish);for(const t of ['a','b'])delete withoutIntake.tenants[t].intakeFormsId;
 writeFileSync(fixtures,JSON.stringify(withoutIntake),{mode:0o600});
 const refusedSetup=spawnSync('node',[directory+'publishing/setup.mjs'],{encoding:'utf8'});
 evidence.refusals.push({kind:'publish form 1 through setup',exit:refusedSetup.status,stderrTail:refusedSetup.stderr.split('\n').filter(l=>/refused/i.test(l)).slice(0,2),edgesBefore,edgesAfter:{a:edgeIdentity('a'),b:edgeIdentity('b')}});
 assert.notEqual(refusedSetup.status,0,'Setup published form 1');assert.deepEqual({a:edgeIdentity('a'),b:edgeIdentity('b')},edgesBefore,'Refused publish must leave running edges untouched');
 // Admit fresh raw forms and publish them.
 for(const t of ['a','b']){const form=ok(api(t,'/forms/new','POST',rawForm('Remold admitted intake '+state.fixture+' '+t))).form;withoutIntake.tenants[t].intakeFormsId=form.id;state.tenants[t].intakeFormId=form.id;save();}
 writeFileSync(fixtures,JSON.stringify(withoutIntake),{mode:0o600});
 const setup=spawnSync('node',[directory+'publishing/setup.mjs'],{encoding:'utf8'});assert.equal(setup.status,0,'Admitted setup failed: '+setup.stderr);
 evidence.publish={previousIntake:{a:publish.tenants.a.intakeFormsId??null,b:publish.tenants.b.intakeFormsId??null},admitted:{a:state.tenants.a.intakeFormId,b:state.tenants.b.intakeFormId},edges:{a:edgeIdentity('a'),b:edgeIdentity('b')},localServerSha256:createHash('sha256').update(readFileSync(directory+'publishing/server.mjs')).digest('hex'),admissions:{a:JSON.parse(readFileSync(directory+'private/publishing/config-a.json')).admission,b:JSON.parse(readFileSync(directory+'private/publishing/config-b.json')).admission},trackingPolicy:TRACKING_POLICY};
 // Missing or foreign tracking policy: the edge refuses to start, so nothing can be served or posted.
 const current=JSON.parse(readFileSync(directory+'private/publishing/config-a.json'));
 for(const [kind,admission] of [['missing admission',undefined],['missing tracking policy',{...current.admission,policy:undefined}],['foreign tracking policy',{...current.admission,policy:'client-supplied'}]]){
  let refused=null;try{createPublicServer({...current,admission});}catch(e){refused=e.message;}
  evidence.refusals.push({kind,refused});assert.ok(refused,'Edge started with '+kind);
 }
}catch(e){evidence.status='FAIL';evidence.failures=[e.message];finish();throw e;}

const failures=[];
for(const t of ['a','b']){
 const row=evidence.tenants[t]={},binding=state.tenants[t];
 binding.email='own-'+state.fixture+'@example.invalid';binding.newEmail='new-'+state.fixture+'@example.invalid';save();
 const owner=ok(api(t,'/contacts/new','POST',{email:binding.email,firstname:'Remold owned '+t,lastname:'Stable owner '+t})).contact;binding.ownerId=owner.id;save();
 ok(api(t,'/contacts/'+owner.id+'/dnc/email/add','POST',{reason:3,comments:'Isolated admission proof'}));
 const before=profile(ok(api(t,'/contacts/'+owner.id)).contact),counts=nativeCounts(t),members=memberships(t);assert.equal(before.doNotContact.length,1);
 const rows=[{email:binding.email,firstname:'Existing A '+state.fixture},{email:binding.email,firstname:'Existing B '+state.fixture},{email:binding.newEmail,firstname:'New A '+state.fixture},{email:binding.newEmail,firstname:'New B '+state.fixture}];
 const sent=edgeSubmit(t,rows,'mtc_id='+owner.id+'; Blocked-Tracking=0');
 const subs=Object.values(ok(api(t,'/forms/'+sent.formId+'/submissions?limit=100&orderBy=s.id&orderByDir=DESC')).submissions).filter(s=>rows.some(r=>r.firstname===s.results.firstname&&r.email===s.results.email));
 const after=profile(ok(api(t,'/contacts/'+owner.id)).contact),countsAfter=nativeCounts(t),newContacts=Object.values(ok(api(t,'/contacts?limit=100&search='+encodeURIComponent(binding.newEmail))).contacts).filter(c=>c.fields.all.email===binding.newEmail).map(c=>c.id);
 Object.assign(row,{edgeFormId:sent.formId,responses:sent.responses.map(r=>({status:r.status,body:r.body})),submissions:subs.map(s=>({id:s.id,leadId:s.lead?.id??null,results:s.results})),ownerBefore:before,ownerAfter:after,countsBefore:counts,countsAfter,membershipsBefore:members,membershipsAfter:memberships(t),newEmailContacts:newContacts});
 const check=(cond,msg)=>{if(!cond)failures.push(t+': '+msg);};
 row.accepted=sent.responses.filter(r=>r.status===200).length;
 check(row.accepted===4,'edge accepted '+row.accepted+'/4 submissions');
 check(subs.length===4&&rows.every(r=>subs.some(s=>s.results.firstname===r.firstname&&s.results.email===r.email)),'expected the four submissions captured, saw '+subs.length);
 check(subs.every(s=>!s.lead),'submission linked to native contact(s) '+subs.map(s=>s.lead?.id).filter(Boolean).join(','));
 check(JSON.stringify(after)===JSON.stringify(before),'existing owner identity or suppression changed');
 check(countsAfter.contacts===counts.contacts&&countsAfter.anonymousContacts===counts.anonymousContacts,'native contacts '+counts.contacts+'->'+countsAfter.contacts+', anonymous '+counts.anonymousContacts+'->'+countsAfter.anonymousContacts);
 check(newContacts.length===0,'new email created native contact(s) '+newContacts.join(','));
 check(countsAfter.queuedEmails===counts.queuedEmails&&countsAfter.emailStats===counts.emailStats,'mail counters changed');
 check(row.membershipsAfter===members,'campaign memberships changed');
}
evidence.failures=failures;evidence.status=failures.length?'FAIL':'PASS';finish();
if(failures.length){console.error('FAIL\n'+failures.join('\n'));process.exit(1);}
console.log('PASS '+mode+': four concurrent public-edge submissions per tenant kept owner identity and suppression, created no native contacts'+(mode==='after'?', and every unsafe form was refused before any native write.':'.'));
