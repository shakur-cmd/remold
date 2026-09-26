// IV attack 4: edit the deployed, admitted intake form after publish (map email and firstname to the contact and
// add a remove-DNC action), post through the running deployed edge, observe, then revert the edit.
import * as L from './lib.mjs';
const {admitForm}=await import('../../../../publishing/admission.mjs');
const t=process.argv[2]??'a',formId=L.deployedFormId(t),token=await L.edgeToken(t);
const snapForm=()=>{const f=L.ok(L.api(t,'/forms/'+formId)).form;return {fields:f.fields.map(x=>({id:x.id,alias:x.alias,type:x.type,mappedObject:x.mappedObject,mappedField:x.mappedField})),actions:Object.values(f.actions??{}).map(a=>({id:a.id,type:a.type}))};};
const admit=()=>{try{admitForm(t,formId);return 'admitted';}catch(e){return e.message;}};
const out={tenant:t,formId,formBefore:snapForm(),admissionBefore:admit()};
const f=L.ok(L.api(t,'/forms/'+formId)).form,email=f.fields.find(x=>x.alias==='email'),first=f.fields.find(x=>x.alias==='firstname');
const edit=L.api(t,'/forms/'+formId+'/edit','PATCH',{fields:[{id:email.id,label:'Email',type:'email',alias:'email',mappedObject:'contact',mappedField:'email'},{id:first.id,label:'First name',type:'text',alias:'firstname',mappedObject:'contact',mappedField:'firstname'},{id:f.fields.find(x=>x.type==='button').id,label:'Submit',type:'button',alias:'submit'}],actions:[{name:'IV remove DNC',type:'lead.remove_do_not_contact',properties:{}}]});
out.edit={status:edit.status,error:edit.status>=300?JSON.stringify(edit.data).slice(0,400):null};out.formEdited=snapForm();out.admissionAfterEdit=admit();
const owner=L.makeOwner(t,'postedit'),p0=L.profile(t,owner.id),c0=L.counts(t),edge0=JSON.parse(L.docker(['inspect',L.prefix+'-public-'+t]))[0].State.StartedAt;
const newEmail='iv-new-'+L.run+'-postedit@example.invalid';
const bodies=[[owner.email,'Edited existing 1'],[owner.email,'Edited existing 2'],[newEmail,'Edited new 1'],[newEmail,'Edited new 2']].map(([e,n])=>L.post(t,'/form/'+formId,L.formBody(e,n,token),'Origin: http://'+L.host(t)+'\r\nCookie: mtc_id='+owner.id+'; Blocked-Tracking=0\r\n'));
// Sequential through the deployed edge (it serializes anyway); rawRequests sends them one after another.
out.responses=L.rawRequests(t,bodies).map(r=>r.statuses);
const p1=L.profile(t,owner.id),c1=L.counts(t);
out.submissions=L.sql(t,`SELECT id,COALESCE(lead_id,'null') FROM form_submissions WHERE form_id=${formId} AND id>${Number(L.sql(t,'SELECT COALESCE(MAX(id),0) FROM form_submissions'))-10} ORDER BY id`);
out.newEmailContacts=L.sql(t,`SELECT id,firstname FROM leads WHERE email='${newEmail}'`);
Object.assign(out,{ownerId:owner.id,ownerBefore:p0,ownerAfter:p1,countersBefore:c0,countersAfter:c1,edgeStartedAtUnchanged:edge0===JSON.parse(L.docker(['inspect',L.prefix+'-public-'+t]))[0].State.StartedAt});
// Revert: remove the action and the mappings.
const cur=L.ok(L.api(t,'/forms/'+formId)).form;
const delA=Object.values(cur.actions??{}).map(a=>a.id);out.revert={};
if(delA.length)out.revert.actions=L.api(t,'/forms/'+formId+'/actions/delete?'+delA.map(i=>'actions[]='+i).join('&'),'DELETE').status;
out.revert.fields=L.api(t,'/forms/'+formId+'/edit','PATCH',{fields:[{id:email.id,label:'Email',type:'email',alias:'email',mappedObject:null,mappedField:null},{id:first.id,label:'First name',type:'text',alias:'firstname',mappedObject:null,mappedField:null},{id:f.fields.find(x=>x.type==='button').id,label:'Submit',type:'button',alias:'submit'}]}).status;
out.formReverted=snapForm();out.admissionAfterRevert=admit();
L.save('a4-post-publish-edit-'+t,out);
console.log(JSON.stringify({edit:out.edit,admissionAfterEdit:out.admissionAfterEdit,responses:out.responses,subs:out.submissions,ownerBefore:p0,ownerAfter:p1,newEmailContacts:out.newEmailContacts,contacts:[c0.contacts,c1.contacts],anon:[c0.anonymousContacts,c1.anonymousContacts],formEdited:out.formEdited,reverted:out.formReverted,admissionAfterRevert:out.admissionAfterRevert,revert:out.revert}));
