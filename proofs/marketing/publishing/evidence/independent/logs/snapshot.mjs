// Read-only native snapshot: submission inventory, contact 1 hash, root evidence hashes. Prints no credentials.
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {directory} from '../../../../runtime.mjs';
import {api} from '../../../../tenants/api.mjs';
const fx=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json'));
const h=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const out={at:new Date().toISOString(),tenants:{},rootEvidence:{}};
for(const t of ['a','b']){
 const s=api(t,'/forms/'+fx.tenants[t].formsId+'/submissions?limit=100');const c1=api(t,'/contacts/1');const cs=api(t,'/contacts?limit=1');
 const subs=Object.values(s.data.submissions??{}).map(x=>({id:x.id,contactId:x.lead?.id??null,email:x.results?.email??null,firstname:x.results?.firstname??null,dateSubmitted:x.dateSubmitted}));
 out.tenants[t]={formId:fx.tenants[t].formsId,submissionTotal:Number(s.data.total),submissions:subs,contactTotal:Number(cs.data.total),contact1Status:c1.status,contact1Sha256:h(c1.data.contact),contact1Email:c1.data.contact?.fields?.all?.email};
}
const ev=directory+'publishing/evidence/';for(const f of readdirSync(ev))if(statSync(ev+f).isFile())out.rootEvidence[f]=h(readFileSync(ev+f));
console.log(JSON.stringify(out,null,1));
