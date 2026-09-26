// Read-only: only the two already accepted fixture messages, never arbitrary mail.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import assert from 'node:assert/strict';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
const before=JSON.parse(readFileSync(join(here,'evidence/live-replay-first-failure.json')));
assert.deepEqual(before.receipts.map(x=>x.name),['P1','Q1']);
const ready=JSON.parse(readFileSync(join(here,'evidence/oauth-ready.json'))),connection=JSON.parse(readFileSync(join(ready.privateDirectory,'mailbox-A.json')));
assert.equal(connection.email,'shakur@envoylogic.com');
const env=Object.fromEntries(readFileSync(join(root,'.env.remold-sandbox.local'),'utf8').split(/\r?\n/).filter(s=>/^GOOGLE_(CLIENT_ID|CLIENT_SECRET)=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).replace(/^(["'])(.*)\1$/,'$2')]}));
const auth=new OAuth2Client(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET);auth.setCredentials(connection.tokens);
const get=async path=>(await auth.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/'+path,method:'GET'})).data;
const p=await get('messages/'+before.receipts[0].providerRef+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To');
const header=name=>p.payload?.headers?.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value;
const q=await get('messages?includeSpamTrash=true&q='+encodeURIComponent('rfc822msgid:'+before.receipts[1].messageId));
const received=[];
for(const row of q.messages??[]){const m=await get('messages/'+row.id+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To');received.push({id:m.id,labels:m.labelIds,headers:m.payload?.headers});}
const evidence={at:new Date().toISOString(),readOnly:true,bodyMessagesFetched:0,providerP1:{id:p.id,thread:p.threadId,labels:p.labelIds,from:header('From'),to:header('To'),messageId:header('Message-ID'),matchesRequestedMessageId:header('Message-ID')===before.receipts[0].messageId},q1ExactMatches:received};
writeFileSync(join(here,'evidence/receipt-diagnostic-gmail.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
