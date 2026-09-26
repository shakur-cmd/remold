// Read-only native API inspection of the replay's new submission and contact in each tenant.
import {readFileSync,writeFileSync} from 'node:fs';
import {directory} from '../../../../runtime.mjs';
import {api} from '../../../../tenants/api.mjs';
const fx=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')),run=JSON.parse(readFileSync(process.argv[2])),out={at:new Date().toISOString(),email:run.submissions[0].email,tenants:{}};
const before=JSON.parse(readFileSync(process.argv[3])),after=JSON.parse(readFileSync(process.argv[4]));
for(const t of ['a','b']){
 const row=run.submissions.find(s=>s.tenant===t),subs=Object.values(api(t,'/forms/'+fx.tenants[t].formsId+'/submissions?limit=100').data.submissions);
 const prior=new Set(before.tenants[t].submissions.map(s=>s.id)),added=subs.filter(s=>!prior.has(s.id));
 const c=api(t,'/contacts/'+row.contactId).data.contact;
 out.tenants[t]={replayRow:row,newSubmissions:added.map(s=>({id:s.id,leadId:s.lead?.id,results:s.results,formId:s.form?.id,page:s.page?.id??null,referer:s.referer??null,trackingId:s.trackingId??null})),
  priorSubmissionsRetained:before.tenants[t].submissions.every(p=>subs.some(s=>s.id===p.id)),
  contact:{id:c.id,email:c.fields.all.email,firstname:c.fields.all.firstname,lastname:c.fields.all.lastname??null,points:c.points,ipAddresses:Object.keys(c.ipAddresses??{}),doNotContact:c.doNotContact?.length??0,utmtags:c.utmtags?.length??0,owner:c.owner??null},
  contact1:{beforeSha256:before.tenants[t].contact1Sha256,afterSha256:after.tenants[t].contact1Sha256,unchanged:before.tenants[t].contact1Sha256===after.tenants[t].contact1Sha256,email:after.tenants[t].contact1Email}};
}
const [A,B]=[out.tenants.a,out.tenants.b];
out.checks={oneNewSubmissionEach:A.newSubmissions.length===1&&B.newSubmissions.length===1,submissionLinksContact:A.newSubmissions[0]?.leadId==A.contact.id&&B.newSubmissions[0]?.leadId==B.contact.id,sameEmail:A.contact.email===B.contact.email&&A.contact.email===out.email,differentTenantFields:A.contact.firstname==='Route A'&&B.contact.firstname==='Route B',contact1Unchanged:A.contact1.unchanged&&B.contact1.unchanged,priorRetained:A.priorSubmissionsRetained&&B.priorSubmissionsRetained};
out.pass=Object.values(out.checks).every(Boolean);
writeFileSync(process.argv[5],JSON.stringify(out,null,1)+'\n');console.log(JSON.stringify(out,null,1));if(!out.pass)process.exit(1);
