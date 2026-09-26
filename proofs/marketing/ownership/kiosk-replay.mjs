import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {directory} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {request} from '../publishing/http.mjs';
import {nativeCounts} from '../publishing/read-effects-replay.mjs';
const privacy=process.argv.includes('--privacy'),phase=privacy?'privacy':'kiosk';
const label=process.argv[2];assert.match(label??'',/^[a-zA-Z0-9_-]+$/);
const statePath=directory+'private/ownership-'+label+'/state.json',state=JSON.parse(readFileSync(statePath)),output=directory+'ownership/evidence/'+label+'/'+phase+'.json';assert.ok(!existsSync(output));
const save=()=>writeFileSync(statePath,JSON.stringify(state),{mode:0o600}),ok=r=>{assert.ok(r.status>=200&&r.status<300);return r.data;},hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile=c=>({id:c.id,firstname:c.fields.all.firstname,lastname:c.fields.all.lastname,company:c.fields.all.company,email:c.fields.all.email,points:c.points,doNotContact:c.doNotContact});
const rows=[];
for(const tenant of ['a','b']){
 const binding=state.tenants[tenant];assert.ok(binding.beforeComplete);assert.ok(!binding[phase+'Started'],'Interrupted effects require read-only reconciliation');binding[phase+'Started']=true;save();
 const beforeCounters=nativeCounts(tenant),list=ok(api(tenant,'/contacts?limit=100&search='+encodeURIComponent(binding.email)));assert.ok(Number(list.total)<=100);
 const matches=Object.values(list.contacts).filter(c=>c.fields.all.email===binding.email);assert.equal(matches.length,1,'Ambiguous email must never select the first match');const canonical=matches[0];
 const retainedBefore=JSON.parse(readFileSync(directory+'ownership/evidence/'+label+'/before.json')).rows.find(r=>r.tenant===tenant);assert.equal(retainedBefore.before.doNotContact.length,1);assert.equal(retainedBefore.before.doNotContact[0].channel,'email');
 const recoveryBefore=profile(canonical);binding.canonicalId=canonical.id;save();
 // Restore only the explicit pre-test identity/suppression of this owned synthetic fixture.
 ok(api(tenant,'/contacts/'+canonical.id+'/edit','PATCH',{firstname:binding.authoritative}));
 if(!canonical.doNotContact.some(r=>r.channel==='email'))ok(api(tenant,'/contacts/'+canonical.id+'/dnc/email/add','POST',{reason:3,comments:'Restore owned synthetic suppression after demonstrated native merge'}));
 const before=profile(ok(api(tenant,'/contacts/'+canonical.id)).contact);assert.equal(before.id,canonical.id);assert.equal(before.firstname,binding.authoritative);assert.ok(before.doNotContact.some(r=>r.channel==='email'));
 const originalForm=ok(api(tenant,'/forms/1')).form;
 const payload={name:'Remold '+phase+' ownership '+state.fixture+' '+tenant,formType:'standalone',inKioskMode:true,isPublished:true,postAction:'return',postActionProperty:'Synthetic capture received',fields:[{label:'Email',type:'email',alias:'email',mappedObject:'contact',mappedField:'email',isRequired:true},{label:'First name',type:'text',alias:'firstname',mappedObject:null,mappedField:null,leadField:null,saveResult:true},{label:'Submit',type:'button',alias:'submit'}],actions:[]};
 binding[phase+'FormIntent']=payload.name;save();const form=ok(api(tenant,'/forms/new','POST',payload)).form;binding[phase+'FormId']=form.id;save();assert.equal(form.inKioskMode,true);assert.equal(form.actions.length,0);
 const submitted='Kiosk suggestion '+tenant,body=new URLSearchParams({'mauticform[formId]':String(form.id),'mauticform[formName]':form.alias,'mauticform[return]':'','mauticform[email]':binding.email,'mauticform[firstname]':submitted}).toString();
 const response=request(tenant,{host:'tenant-'+tenant+'.marketing-proof.invalid',path:'/form/submit?formId='+form.id+'&ajax=1',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...(privacy?{DNT:'1','Sec-GPC':'1'}:{})},body});assert.equal(response.status,200);assert.equal(JSON.parse(response.body).success,1);
 const after=profile(ok(api(tenant,'/contacts/'+canonical.id)).contact);assert.deepEqual(after,before,'Native form must preserve canonical ID, profile and email suppression');
 const submissions=ok(api(tenant,'/forms/'+form.id+'/submissions?limit=100'));assert.equal(Number(submissions.total),1);const submission=Object.values(submissions.submissions)[0];assert.equal(submission.lead.id,canonical.id);assert.equal(submission.results.firstname,submitted);assert.equal(submission.results.email,binding.email);
 const countersAfter=nativeCounts(tenant);assert.equal(countersAfter.contacts,beforeCounters.contacts);assert.equal(countersAfter.submissions,beforeCounters.submissions+1);assert.equal(countersAfter.queuedEmails,beforeCounters.queuedEmails);assert.equal(countersAfter.emailStats,beforeCounters.emailStats);assert.equal(hash(ok(api(tenant,'/forms/1')).form),hash(originalForm));
 rows.push({tenant,originalContactId:binding.contactId,canonicalContactId:canonical.id,recoveryBefore,before,after,formId:form.id,kioskMode:form.inKioskMode,fields:form.fields.map(f=>({alias:f.alias,mappedObject:f.mappedObject,mappedField:f.mappedField,leadField:f.leadField,saveResult:f.saveResult})),submission:{id:submission.id,leadId:submission.lead.id,results:submission.results},beforeCounters,countersAfter,originalFormUnchanged:true});binding[phase+'Complete']=true;save();
}
writeFileSync(output,JSON.stringify({status:'PASS',level:'SERVICE bounded native kiosk form revision, no public-edge or CRM integration',rows},null,2)+'\n',{flag:'wx'});console.log('PASS two native kiosk forms preserve canonical identity and suppression while storing submitted suggestions.');
