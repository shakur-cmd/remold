import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {docker,directory,prefix} from '../runtime.mjs';
import {request} from './http.mjs';
export function nativeCounts(t){
 const row=docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',"SELECT (SELECT COUNT(*) FROM leads),(SELECT COUNT(*) FROM leads WHERE email IS NULL),(SELECT COUNT(*) FROM page_hits),(SELECT COUNT(*) FROM asset_downloads),(SELECT COUNT(*) FROM form_submissions),(SELECT COUNT(*) FROM messenger_messages),(SELECT COUNT(*) FROM email_stats)"]).trim().split('\t').map(Number);
 return Object.fromEntries(['contacts','anonymousContacts','pageHits','assetDownloads','submissions','queuedEmails','emailStats'].map((k,i)=>[k,row[i]]));
}
if(process.argv[1]?.endsWith('/read-effects-replay.mjs')){
 const phase=process.argv[2];assert.ok(['before','after'].includes(phase));const state=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')),rows=[];
 for(const t of ['a','b']){const before=nativeCounts(t);for(const path of ['/'+state.tenants[t].publicPageAlias,new URL(state.tenants[t].assetDownloadUrl).pathname]){const r=request(t,{host:'tenant-'+t+'.marketing-proof.invalid',path,container:'public',port:8080});assert.equal(r.status,200);}rows.push({tenant:t,before,after:nativeCounts(t)});}
 writeFileSync((process.env.REMOLD_PUBLISH_EVIDENCE_DIR??directory+'publishing/evidence/')+'read-effects-'+phase+'.json',JSON.stringify({capturedAt:new Date().toISOString(),phase,rows},null,2)+'\n');
 for(const row of rows)assert.deepEqual(row.after,row.before,'Public page/asset reads must not mutate native contacts or tracking rows');
 console.log('PASS public page/asset reads leave native contacts, tracking rows, submissions and mail counters unchanged.');
}
