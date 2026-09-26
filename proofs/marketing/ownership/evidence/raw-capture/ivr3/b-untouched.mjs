// Read-only: tenant B Mautic counters now, compared with the end of r4 (the last run allowed to write B).
import {readFileSync,writeFileSync} from 'node:fs';
import {docker,prefix,directory} from '../../../../runtime.mjs';
const k=['formSubmissions','contacts','anonymousContacts','dnc','campaignLeads','queuedEmails','emailStats'];
const v=docker(['exec',prefix+'-db-b','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--','SELECT (SELECT COUNT(*) FROM form_submissions),(SELECT COUNT(*) FROM leads),(SELECT COUNT(*) FROM leads WHERE email IS NULL),(SELECT COUNT(*) FROM lead_donotcontact),(SELECT COUNT(*) FROM campaign_leads),(SELECT COUNT(*) FROM messenger_messages),(SELECT COUNT(*) FROM email_stats)']).trim().split('\t').map(Number);
const now=Object.fromEntries(k.map((x,i)=>[x,v[i]])),r4=JSON.parse(readFileSync(directory+'ownership/evidence/raw-capture/r4.json')).mauticEnd.b;
const out={at:new Date().toISOString(),r4End:r4,now,unchanged:JSON.stringify(now)===JSON.stringify(r4)};
writeFileSync(new URL('./b-untouched.json',import.meta.url),JSON.stringify(out,null,1)+'\n');console.log(JSON.stringify(out));
