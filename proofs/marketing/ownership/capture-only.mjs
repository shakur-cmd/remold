import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {directory,context,prefix,docker} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {nativeCounts} from '../publishing/read-effects-replay.mjs';
const label=process.argv[2];assert.match(label??'',/^[a-zA-Z0-9_-]+$/);
const statePath=directory+'private/ownership-'+label+'/state.json',state=JSON.parse(readFileSync(statePath)),output=directory+'ownership/evidence/'+label+'/capture-only.json';assert.ok(!existsSync(output));
const save=()=>writeFileSync(statePath,JSON.stringify(state),{mode:0o600}),ok=r=>{assert.ok(r.status>=200&&r.status<300,'Native API refused proof request');return r.data;};
const profile=c=>({id:c.id,fields:c.fields.all,doNotContact:c.doNotContact,points:c.points});
const membershipCount=t=>Number(docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "SELECT COUNT(*) FROM campaign_leads;"']).trim());
function send(tenant,form,rows){
 const script=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const output=await Promise.all(a.rows.map(async row=>{const body=new URLSearchParams({'mauticform[formId]':String(a.id),'mauticform[formName]':a.alias,'mauticform[return]':'','mauticform[email]':row.email,'mauticform[firstname]':row.firstname});const r=await fetch('http://127.0.0.1/form/submit?formId='+a.id+'&ajax=1',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':'Blocked-Tracking=1',DNT:'1','Sec-GPC':'1'},body,signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json()};}));console.log(JSON.stringify(output));`;
 const responses=JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-web-'+tenant,'node','--input-type=module','-e',script],{input:JSON.stringify({id:form.id,alias:form.alias,rows}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 for(const r of responses){assert.equal(r.status,200);assert.equal(r.body.success,1);}return responses.map(r=>({status:r.status,success:r.body.success}));
}
const evidence=[];
for(const tenant of ['a','b']){
 const binding=state.tenants[tenant];assert.ok(binding.privacyComplete);assert.ok(!binding.captureOnlyStarted,'Reconcile interrupted effects before another attempt');binding.captureOnlyStarted=true;save();
 const before=nativeCounts(tenant),membersBefore=membershipCount(tenant),original=profile(ok(api(tenant,'/contacts/'+binding.canonicalId)).contact);assert.equal(original.id,binding.canonicalId);assert.ok(original.doNotContact.some(d=>d.channel==='email'));
 const form=ok(api(tenant,'/forms/new','POST',{name:'Remold raw intake '+state.fixture+' '+tenant,formType:'standalone',inKioskMode:true,isPublished:true,postAction:'return',postActionProperty:'Synthetic intake received',fields:[{label:'Email',type:'email',alias:'email',isRequired:true,saveResult:true},{label:'First name',type:'text',alias:'firstname',saveResult:true},{label:'Submit',type:'button',alias:'submit'}],actions:[]})).form;binding.captureOnlyFormId=form.id;save();
 assert.equal(form.actions.length,0);for(const f of form.fields)for(const k of ['mappedObject','mappedField','leadField'])assert.ok(f[k]==null||f[k]==='');
 const newEmail='intake-'+state.fixture+'@example.invalid',rows=[{email:binding.email,firstname:'Existing suggestion 1'},{email:binding.email,firstname:'Existing suggestion 2'},{email:newEmail,firstname:'Concurrent suggestion 1'},{email:newEmail,firstname:'Concurrent suggestion 2'}];
 const responses=send(tenant,form,rows),submissions=ok(api(tenant,'/forms/'+form.id+'/submissions?limit=100'));assert.equal(Number(submissions.total),4);
 const captured=Object.values(submissions.submissions).map(s=>({id:s.id,contactId:s.lead?.id??null,results:s.results}));assert.ok(captured.every(c=>c.contactId===null),'Untrusted intake must not resolve a native contact');
 for(const row of rows)assert.equal(captured.filter(c=>c.results.email===row.email&&c.results.firstname===row.firstname).length,1);
 assert.deepEqual(profile(ok(api(tenant,'/contacts/'+binding.canonicalId)).contact),original);
 const after=nativeCounts(tenant);assert.deepEqual(after,{...before,submissions:before.submissions+4});assert.equal(membershipCount(tenant),membersBefore);
 const found=ok(api(tenant,'/contacts?limit=100&search='+encodeURIComponent(newEmail)));assert.equal(Object.values(found.contacts).filter(c=>c.fields.all.email===newEmail).length,0);
 evidence.push({tenant,formId:form.id,responses,captured,before,after,existingContactId:original.id,existingProfileAndSuppressionUnchanged:true,campaignMemberships:{before:membersBefore,after:membershipCount(tenant)},newEmailNativeContacts:0});binding.captureOnlyComplete=true;save();
}
writeFileSync(output,JSON.stringify({status:'PASS',level:'SERVICE raw capture-only native forms; no edge promotion or core Person reconciliation',evidence},null,2)+'\n',{flag:'wx'});console.log('PASS capture-only forms: four concurrent submissions per tenant, zero contact/profile/suppression/queue/campaign effects.');
