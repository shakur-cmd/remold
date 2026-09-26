// IV attack 1b: campaign decision and point action that reference a form by event properties, with a positive
// control. One campaign decision and one point action reference both an admitted raw form R and a mapped control
// form M. R is posted through the committed edge code; M is posted natively with the same Blocked-Tracking cookie.
// If M moves the owner's points/campaign log, the decision and point action were live, so R's zero effect is real.
import * as L from './lib.mjs';
const {admitForm}=await import('../../../../publishing/admission.mjs');
const t=process.argv[2]??'a',name=k=>'IV control '+k+' '+L.run+' '+t;
const R=L.ok(L.api(t,'/forms/new','POST',L.rawForm(name('raw')))).form;
const M=L.ok(L.api(t,'/forms/new','POST',L.rawForm(name('mapped'),{fields:[{label:'Email',type:'email',alias:'email',isRequired:true,saveResult:true,mappedObject:'contact',mappedField:'email'},{label:'First name',type:'text',alias:'firstname',saveResult:true},{label:'Submit',type:'button',alias:'submit'}]}))).form;
const segment=L.ok(L.api(t,'/segments/new','POST',{name:name('source'),isPublished:true})).list;
const campaign=L.ok(L.api(t,'/campaigns/new','POST',{name:name('campaign'),isPublished:true,lists:[{id:segment.id}],events:[
 {id:'new1',name:'IV submitted',type:'form.submit',eventType:'decision',order:1,properties:{forms:[R.id,M.id]},triggerMode:'immediate'},
 {id:'new2',name:'IV points',type:'lead.changepoints',eventType:'action',order:2,properties:{points:7},triggerMode:'immediate',parent:'new1',decisionPath:'yes'}]})).campaign;
const point=L.ok(L.api(t,'/points/new','POST',{name:name('point'),type:'form.submit',delta:9,isPublished:true,properties:{forms:[R.id,M.id]}})).point;
const admission=admitForm(t,R.id).admission;let mRefused=null;try{admitForm(t,M.id);}catch(e){mRefused=e.message;}
const owner=L.makeOwner(t,'control');L.ok(L.api(t,'/campaigns/'+campaign.id+'/contact/'+owner.id+'/add','POST',{}));
const p0=L.profile(t,owner.id),c0=L.counts(t);
const edge=L.probeEdge(t,{form:L.edgeFormConfig(L.ok(L.api(t,'/forms/'+R.id)).form),admission,rows:[{email:owner.email,firstname:'Via edge'},{email:owner.email,firstname:'Via edge 2'}],clientCookie:'mtc_id='+owner.id+'; Blocked-Tracking=0'});
const p1=L.profile(t,owner.id),c1=L.counts(t),log1=L.sql(t,'SELECT COUNT(*) FROM campaign_lead_event_log WHERE campaign_id='+campaign.id);
const control=L.inContainer(L.prefix+'-public-'+t,`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const r=await fetch(a.url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:'Blocked-Tracking=1',DNT:'1','Sec-GPC':'1'},body:new URLSearchParams({'mauticform[formId]':String(a.form),'mauticform[formName]':a.alias,'mauticform[return]':'','mauticform[email]':a.email,'mauticform[firstname]':'Mapped control'})});console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}));`,{url:'http://'+L.prefix+'-web-'+t+'/form/submit?formId='+M.id+'&ajax=1',form:M.id,alias:M.alias,email:owner.email});
const p2=L.profile(t,owner.id),c2=L.counts(t),log2=L.sql(t,'SELECT lead_id,event_id FROM campaign_lead_event_log WHERE campaign_id='+campaign.id),plog=L.sql(t,'SELECT lead_id,point_id FROM point_lead_action_log WHERE point_id='+point.id);
const subsR=L.submissionsFor(t,R.id),subsM=L.submissionsFor(t,M.id);
const out={tenant:t,rawFormId:R.id,mappedFormId:M.id,mappedAdmissionRefused:mRefused,rawAdmissionFormSha:admission.formSha256,campaignId:campaign.id,segmentId:segment.id,pointId:point.id,ownerId:owner.id,
 edge:{responses:edge.map(r=>r.status),submissions:subsR,ownerBefore:p0,ownerAfter:p1,countersBefore:c0,countersAfter:c1,campaignLogRows:Number(log1)},
 control:{response:control,submissions:subsM,ownerAfter:p2,countersAfter:c2,campaignLog:log2,pointLog:plog}};
L.save('a1b-decision-control-'+t,out);
console.log(JSON.stringify({edge:{r:out.edge.responses,leads:subsR.map(s=>s.lead),points:[p0.points,p1.points],dnc:[p0.doNotContact.length,p1.doNotContact.length],log:log1},control:{r:control.status,leads:subsM.map(s=>s.lead),points:p2.points,first:p2.firstname,dnc:p2.doNotContact.length,log:log2,plog,contacts:[c1.contacts,c2.contacts]}}));
