// IV attack 1: forms that are mapped, actioned, campaign-linked or reshaped by routes the builder did not test.
// Each variant is created fresh; admission runs; anything admitted is posted through an in-process copy of the
// committed server.mjs (same image and network as the deployed edge) and native effects are measured.
import * as L from './lib.mjs';
const {admitForm}=await import('../../../../publishing/admission.mjs');
const t=process.argv[2]??'a';const out={tenant:t,variants:[]};
const name=k=>'IV admission '+k+' '+L.run+' '+t;
const tryAdmit=id=>{try{return {admitted:true,admission:admitForm(t,id).admission};}catch(e){return {admitted:false,refused:e.message};}};
async function variant(kind,formOver,{after,probe=true}={}){
 const before=L.counts(t);
 const form=L.ok(L.api(t,'/forms/new','POST',L.rawForm(name(kind),formOver))).form;
 const extra=after?await after(form):{};
 const adm=tryAdmit(form.id),mid=L.counts(t);
 const row={kind,formId:form.id,...adm,countersUnchangedByAdmission:JSON.stringify(mid)===JSON.stringify(before),...extra.info};
 if(adm.admitted&&probe){
  const owner=L.makeOwner(t,kind),ownerBefore=L.profile(t,owner.id),c0=L.counts(t);
  const newEmail='iv-new-'+L.run+'-'+kind+'@example.invalid';
  const rows=[{email:owner.email,firstname:'Hostile existing '+kind},{email:newEmail,firstname:'Hostile new '+kind}];
  let responses;try{responses=L.probeEdge(t,{form:L.edgeFormConfig(adm.admission&&(await L.ok(L.api(t,'/forms/'+form.id))).form),admission:adm.admission,rows,clientCookie:'mtc_id='+owner.id+'; Blocked-Tracking=0'});}catch(e){responses=[{error:e.message.slice(0,300)}];}
  const subs=L.submissionsFor(t,form.id),c1=L.counts(t),ownerAfter=L.profile(t,owner.id);
  const results=L.resultsTable(t,form.id),stored=results?L.sql(t,`SELECT * FROM ${results} ORDER BY submission_id`):null;
  Object.assign(row,{probe:{ownerId:owner.id,responses:responses.map(r=>r.status??r.error),submissions:subs,storedResults:stored,ownerUnchanged:JSON.stringify(ownerBefore)===JSON.stringify(ownerAfter),ownerBefore,ownerAfter,countersBefore:c0,countersAfter:c1}});
  if(extra.check)row.probe.extra=extra.check(owner,ownerBefore,ownerAfter);
 }
 out.variants.push(row);console.log(JSON.stringify({kind,formId:form.id,admitted:adm.admitted,refused:adm.refused,probe:row.probe&&{responses:row.probe.responses,leads:row.probe.submissions.map(s=>s.lead),ownerUnchanged:row.probe.ownerUnchanged,contacts:[row.probe.countersBefore.contacts,row.probe.countersAfter.contacts],campaignLog:[row.probe.countersBefore.campaignEventLog,row.probe.countersAfter.campaignEventLog],points:[row.probe.countersBefore.pointActionLog,row.probe.countersAfter.pointActionLog],stored:row.probe.storedResults}}));
 return {form,row};
}
const f=(label,type,alias,more={})=>({label,type,alias,saveResult:true,...more});
const base=[f('Email','email','email',{isRequired:true}),f('First name','text','firstname')],button={label:'Submit',type:'button',alias:'submit'};
// Shape and field routes
await variant('hidden-field',{fields:[...base,f('Source','hidden','utm_source',{defaultValue:'x'}),button]});
await variant('freetext-display',{fields:[...base,{label:'Note',type:'freetext',alias:'note',properties:{text:'hi'}},button]});
await variant('select-extra',{fields:[...base,f('Pick','select','pick',{properties:{list:{list:[{label:'A',value:'a'}]}}}),button]});
await variant('alias-case',{fields:[f('Email','email','Email',{isRequired:true}),f('First name','text','FirstName'),button]});
await variant('swapped-types',{fields:[f('Email','text','email'),f('First name','email','firstname'),button]});
await variant('company-mapped',{fields:[base[0],f('First name','text','firstname',{mappedObject:'company',mappedField:'companyname'}),button]});
await variant('button-mapped',{fields:[...base,{label:'Submit',type:'button',alias:'submit',mappedObject:'contact',mappedField:'email'}]});
await variant('email-not-saved',{fields:[f('Email','email','email',{isRequired:true,saveResult:false}),f('First name','text','firstname',{saveResult:false}),button]});
await variant('autofill-default',{fields:[f('Email','email','email',{isRequired:true,isAutoFill:true}),f('First name','text','firstname',{defaultValue:'Injected default'}),button]});
await variant('post-action-redirect',{postAction:'redirect',postActionProperty:'http://example.invalid/after'});
await variant('publish-down-past',{publishDown:'2020-01-01 00:00:00'});
await variant('kiosk-mode',{inKioskMode:true});
// Campaign decision referencing the form in event properties (not as a campaign source), owner a campaign member.
await variant('campaign-decision',{},{after:async form=>{
 const segment=L.ok(L.api(t,'/segments/new','POST',{name:name('decision source'),isPublished:true})).list;
 const campaign=L.ok(L.api(t,'/campaigns/new','POST',{name:name('decision campaign'),isPublished:true,lists:[{id:segment.id}],events:[
  {id:'new1',name:'IV submitted form',type:'form.submit',eventType:'decision',order:1,properties:{forms:[form.id]},triggerMode:'immediate'},
  {id:'new2',name:'IV points',type:'lead.changepoints',eventType:'action',order:2,properties:{points:7},triggerMode:'immediate',parent:'new1',decisionPath:'yes'}]})).campaign;
 const xref=Number(L.sql(t,'SELECT COUNT(*) FROM campaign_form_xref WHERE form_id='+form.id));
 const events=L.sql(t,'SELECT id,type,event_type,properties FROM campaign_events WHERE campaign_id='+campaign.id);
 return {info:{segmentId:segment.id,campaignId:campaign.id,campaignFormXref:xref,campaignEvents:events},check:null};
}}).then(async ({form,row})=>{
 // Put the owner into the campaign before posting would have been ideal; do a second, explicit round now.
 if(!row.admitted)return;
 const campaignId=row.campaignId,owner=L.makeOwner(t,'decision-member');
 L.ok(L.api(t,'/campaigns/'+campaignId+'/contact/'+owner.id+'/add','POST',{}));
 const before=L.profile(t,owner.id),c0=L.counts(t),adm=row.admission,cfg=L.edgeFormConfig(L.ok(L.api(t,'/forms/'+form.id)).form);
 const responses=L.probeEdge(t,{form:cfg,admission:adm,rows:[{email:owner.email,firstname:'Member via edge'}],clientCookie:'mtc_id='+owner.id+'; Blocked-Tracking=0'});
 const mid=L.counts(t),afterEdge=L.profile(t,owner.id);
 // Positive control: the same campaign fires when the native form is posted without the edge's tracking block
 // while claiming the member via mtc_id. This proves the decision was live and the edge is what stopped it.
 const control=L.inContainer(L.prefix+'-public-'+t,`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const r=await fetch(a.url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:'mtc_id='+a.owner},body:new URLSearchParams({'mauticform[formId]':String(a.form),'mauticform[formName]':a.alias,'mauticform[return]':'','mauticform[email]':a.email,'mauticform[firstname]':'Member direct'})});console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}));`,{url:'http://'+L.prefix+'-web-'+t+'/form/submit?formId='+form.id+'&ajax=1',owner:owner.id,form:form.id,alias:form.alias,email:owner.email});
 const c1=L.counts(t),afterControl=L.profile(t,owner.id),subs=L.submissionsFor(t,form.id),log=L.sql(t,'SELECT lead_id,event_id FROM campaign_lead_event_log WHERE campaign_id='+campaignId);
 row.memberRound={ownerId:owner.id,edgeResponses:responses.map(r=>r.status),ownerBefore:before,ownerAfterEdge:afterEdge,countersBefore:c0,countersAfterEdge:mid,control,ownerAfterDirectControl:afterControl,countersAfterControl:c1,submissions:subs,campaignLog:log};
 console.log(JSON.stringify({memberRound:{edge:responses.map(r=>r.status),pointsBefore:before.points,afterEdge:afterEdge.points,afterControl:afterControl.points,log,subs,control:control.status,anon:[c0.anonymousContacts,mid.anonymousContacts,c1.anonymousContacts]}}));
});
// Point action on form submit.
await variant('point-action',{},{after:async form=>{
 const point=L.api(t,'/points/new','POST',{name:name('point'),type:'form.submit',delta:9,isPublished:true,properties:{forms:[form.id]}});
 return {info:{pointCreate:point.status,pointId:point.data?.point?.id??null}};
}});
L.save('a1-admission-routes-'+t,out);
