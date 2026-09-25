import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {docker} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/runtime.mjs';
import {api} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/tenants/api.mjs';
import {nativeCounts} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/publishing/read-effects-replay.mjs';
const h=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const q=(t,sql)=>docker(['exec','remold-marketing-proof-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',sql]).trim();
const out={at:new Date().toISOString(),tenants:{}};
for(const t of ['a','b']){
 const form1=api(t,'/forms/1').data.form;
 const leads=q(t,"SELECT id,IFNULL(email,''),IFNULL(firstname,''),IFNULL(lastname,''),IFNULL(company,''),points,date_modified FROM leads ORDER BY id").split('\n').filter(Boolean).map(r=>r.split('\t'));
 const dnc=q(t,"SELECT id,lead_id,channel,reason,date_added FROM lead_donotcontact ORDER BY id").split('\n').filter(Boolean);
 const forms=q(t,"SELECT id,name,in_kiosk_mode,is_published FROM forms ORDER BY id").split('\n').filter(Boolean).map(r=>r.split('\t'));
 const fields=q(t,"SELECT form_id,alias,IFNULL(mapped_object,'-'),IFNULL(mapped_field,'-'),IFNULL(lead_field,'-') FROM form_fields ORDER BY form_id,id").split('\n');
 const perForm=q(t,"SELECT form_id,COUNT(*) FROM form_submissions GROUP BY form_id ORDER BY form_id");
 const campaignLeads=q(t,"SELECT campaign_id,lead_id,manually_removed FROM campaign_leads ORDER BY campaign_id,lead_id");
 const campaigns=q(t,"SELECT COUNT(*) FROM campaigns"),campForm=q(t,"SELECT COUNT(*) FROM campaign_form_xref");
 const queue=q(t,"SELECT COUNT(*) FROM messenger_messages"),stats=q(t,"SELECT COUNT(*) FROM email_stats"),merges=q(t,"SELECT COUNT(*) FROM contact_merge_records");
 out.tenants[t]={counts:nativeCounts(t),form1Sha256:h(form1),form1Fields:form1.fields.map(f=>[f.alias,f.mappedObject,f.mappedField]),form1InKiosk:form1.inKioskMode,maxLeadId:leads.length?Number(leads.at(-1)[0]):0,leadRows:leads.length,leadRowHashes:Object.fromEntries(leads.map(r=>[r[0],h(r)])),leadsAllSha256:h(leads),dncRows:dnc.length,dncSha256:h(dnc),forms:forms.map(f=>({id:+f[0],kiosk:f[2],published:f[3],nameSha:h(f[1]).slice(0,12)})),formFieldsSha256:h(fields),submissionsPerForm:perForm,campaignLeadsSha256:h(campaignLeads),campaignLeadRows:campaignLeads?campaignLeads.split('\n').length:0,campaigns:+campaigns,campaignFormXref:+campForm,messengerMessages:+queue,emailStats:+stats,mergeRecords:+merges};
}
const file=process.argv[2];writeFileSync(file,JSON.stringify(out,null,1)+'\n',{mode:0o600});console.log(JSON.stringify(Object.fromEntries(Object.entries(out.tenants).map(([k,v])=>[k,{...v,leadRowHashes:undefined}]))));
