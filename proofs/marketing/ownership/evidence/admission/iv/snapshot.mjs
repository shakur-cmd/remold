// Independent verifier snapshot of the isolated Mautic A/B tenants and public edges. Read-only.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker,directory,prefix} from '../../../../runtime.mjs';
const sql=(t,q)=>docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
const h=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const out={capturedAt:new Date().toISOString(),tenants:{}};
for(const t of ['a','b']){
 const q="SELECT (SELECT COUNT(*) FROM leads),(SELECT COUNT(*) FROM leads WHERE email IS NULL),(SELECT COALESCE(MAX(id),0) FROM leads),(SELECT COUNT(*) FROM lead_donotcontact),(SELECT COUNT(*) FROM form_submissions),(SELECT COALESCE(MAX(id),0) FROM form_submissions),(SELECT COUNT(*) FROM forms),(SELECT COALESCE(MAX(id),0) FROM forms),(SELECT COUNT(*) FROM form_actions),(SELECT COUNT(*) FROM campaigns),(SELECT COUNT(*) FROM campaign_events),(SELECT COUNT(*) FROM campaign_leads),(SELECT COUNT(*) FROM campaign_form_xref),(SELECT COUNT(*) FROM campaign_lead_event_log),(SELECT COUNT(*) FROM point_lead_action_log),(SELECT COUNT(*) FROM points),(SELECT COUNT(*) FROM webhooks),(SELECT COUNT(*) FROM webhook_queue),(SELECT COUNT(*) FROM messenger_messages),(SELECT COUNT(*) FROM email_stats),(SELECT COUNT(*) FROM page_hits),(SELECT COUNT(*) FROM asset_downloads),(SELECT COUNT(*) FROM audit_log)";
 const keys=['contacts','anonymousContacts','maxLeadId','dnc','submissions','maxSubmissionId','forms','maxFormId','formActions','campaigns','campaignEvents','campaignLeads','campaignFormXref','campaignEventLog','pointActionLog','points','webhooks','webhookQueue','queuedEmails','emailStats','pageHits','assetDownloads','auditLog'];
 const row=sql(t,q).split('\t').map(Number);
 const edge=JSON.parse(docker(['inspect',prefix+'-public-'+t]))[0];
 out.tenants[t]={counts:Object.fromEntries(keys.map((k,i)=>[k,row[i]])),edge:{id:edge.Id,running:edge.State.Running,startedAt:edge.State.StartedAt,serverSha256:edge.State.Running?docker(['exec',prefix+'-public-'+t,'sha256sum','/public-server.mjs']).split(' ')[0]:null,ports:Object.keys(edge.HostConfig.PortBindings??{}).length,networks:Object.keys(edge.NetworkSettings.Networks)},config:JSON.parse(readFileSync(directory+'private/publishing/config-'+t+'.json')).form.id};
}
out.fixturesSha256=h(directory+'private/publishing/fixtures.json');
out.intake=Object.fromEntries(['a','b'].map(t=>[t,JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')).tenants[t].intakeFormsId??null]));
const label=process.argv[2];console.log(JSON.stringify(out,null,1));
if(label)writeFileSync(new URL('./snap-'+label+'.json',import.meta.url),JSON.stringify(out,null,1)+'\n',{flag:'wx'});
