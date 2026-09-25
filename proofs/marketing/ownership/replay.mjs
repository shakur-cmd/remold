import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {directory} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {request} from '../publishing/http.mjs';
import {nativeCounts} from '../publishing/read-effects-replay.mjs';
const [label,phase]=process.argv.slice(2);assert.match(label??'',/^[a-zA-Z0-9_-]+$/);assert.ok(['before','after'].includes(phase));
const privateDir=directory+'private/ownership-'+label+'/',output=directory+'ownership/evidence/'+label+'/';mkdirSync(privateDir,{recursive:true,mode:0o700});mkdirSync(output,{recursive:true});
const statePath=privateDir+'state.json';let state;
if(existsSync(statePath))state=JSON.parse(readFileSync(statePath));else{assert.equal(phase,'before');state={fixture:randomUUID(),tenants:{a:{},b:{}}};save();}
function save(){writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
const ok=r=>{assert.ok(r.status>=200&&r.status<300,'Native API refused proof request');return r.data;};
const contact=(t,id)=>ok(api(t,'/contacts/'+id)).contact;
const owned=c=>({firstname:c.fields.all.firstname,lastname:c.fields.all.lastname,company:c.fields.all.company,email:c.fields.all.email,points:c.points,doNotContact:c.doNotContact});
function submit(t,form,email,firstname){
 assert.equal(form.actions.length,0);const body=new URLSearchParams({'mauticform[email]':email,'mauticform[firstname]':firstname,'mauticform[formId]':String(form.id),'mauticform[formName]':form.alias,'mauticform[return]':''}).toString();
 const response=request(t,{host:'tenant-'+t+'.marketing-proof.invalid',path:'/form/submit?formId='+form.id+'&ajax=1',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
 assert.equal(response.status,200);assert.equal(JSON.parse(response.body).success,1);
 const submissions=ok(api(t,'/forms/'+form.id+'/submissions?limit=100'));assert.ok(Number(submissions.total)<=100);const matches=Object.values(submissions.submissions).filter(s=>s.results.email===email&&s.results.firstname===firstname);assert.equal(matches.length,1);return {id:matches[0].id,leadId:matches[0].lead?.id,results:matches[0].results};
}
const evidence=output+phase+'.json';assert.ok(!existsSync(evidence),'Preserve phase evidence; use its saved state, not a repeated write');const rows=[];
for(const tenant of ['a','b']){
 const binding=state.tenants[tenant];assert.ok(!binding[phase+'Started'],'An interrupted phase needs read-only reconciliation before another effect');binding[phase+'Started']=true;save();
 const countersBefore=nativeCounts(tenant),originalForm=ok(api(tenant,'/forms/1')).form;
 if(phase==='before'){
  binding.email='ownership-'+state.fixture+'@example.invalid';binding.authoritative='Remold owned '+tenant;save();
  const created=ok(api(tenant,'/contacts/new','POST',{email:binding.email,firstname:binding.authoritative,lastname:'Stable owner '+tenant})).contact;binding.contactId=created.id;save();
  ok(api(tenant,'/contacts/'+created.id+'/dnc/email/add','POST',{reason:3,comments:'Isolated ownership proof'}));
  const before=owned(contact(tenant,created.id)),submission=submit(tenant,originalForm,binding.email,'Public replacement '+tenant),after=owned(contact(tenant,created.id));
  rows.push({tenant,contactId:created.id,before,after,submission,countersBefore,countersAfter:nativeCounts(tenant),authoritativeNamePreserved:after.firstname===before.firstname});
 }else{
  assert.ok(binding.contactId);const old=contact(tenant,binding.contactId);assert.equal(old.fields.all.email,binding.email);
  const beforePatch=owned(old);ok(api(tenant,'/contacts/'+binding.contactId+'/edit','PATCH',{firstname:binding.authoritative}));const afterPatch=owned(contact(tenant,binding.contactId));assert.deepEqual(afterPatch,{...beforePatch,firstname:binding.authoritative},'Identity-only PATCH must preserve native consent and unrelated fields');
  const payload={name:'Remold ownership '+state.fixture+' '+tenant,formType:'standalone',isPublished:true,postAction:'return',postActionProperty:'Synthetic capture received',fields:[{label:'Email',type:'email',alias:'email',mappedObject:'contact',mappedField:'email',isRequired:true},{label:'First name',type:'text',alias:'firstname',mappedObject:null,mappedField:null,leadField:null,saveResult:true},{label:'Submit',type:'button',alias:'submit'}],actions:[]};
  binding.formIntent=payload.name;save();const form=ok(api(tenant,'/forms/new','POST',payload)).form;binding.formId=form.id;save();
  const field=form.fields.find(f=>f.alias==='firstname');for(const key of ['mappedObject','mappedField','leadField'])assert.ok(field[key]==null||field[key]==='','Capture-only name must not map to contact identity');assert.equal(field.saveResult,true);
  const submission=submit(tenant,form,binding.email,'Captured suggestion '+tenant),after=owned(contact(tenant,binding.contactId));assert.deepEqual(after,afterPatch,'Untrusted intake must preserve authoritative identity and suppression');assert.equal(submission.leadId,binding.contactId);
  assert.deepEqual(ok(api(tenant,'/forms/1')).form,originalForm,'Historical form definition remains unchanged');
  rows.push({tenant,contactId:binding.contactId,beforePatch,afterPatch,after,submission,newFormId:form.id,nameField:field,originalFormSha256:createHash('sha256').update(JSON.stringify(originalForm)).digest('hex'),countersBefore,countersAfter:nativeCounts(tenant),authoritativeNamePreserved:true});
 }
 binding[phase+'Complete']=true;save();
}
writeFileSync(evidence,JSON.stringify({phase,level:'SERVICE actual native A/B form and identity ownership; no public edge revision or CRM integration',rows},null,2)+'\n',{flag:'wx'});
for(const row of rows){assert.equal(row.countersAfter.queuedEmails,row.countersBefore.queuedEmails);assert.equal(row.countersAfter.emailStats,row.countersBefore.emailStats);assert.equal(row.authoritativeNamePreserved,true,'Native form overwrote authoritative profile identity');}
console.log('PASS capture-only form result retains submitted name without replacing authoritative profile or suppression.');
