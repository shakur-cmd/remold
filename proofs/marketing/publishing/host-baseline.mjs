import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {directory} from '../runtime.mjs';
import {request} from './http.mjs';
const state=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')),rows=[];
for(const tenant of ['a','b']){
 const binding=state.tenants[tenant],host='tenant-'+tenant+'.marketing-proof.invalid',foreign='tenant-'+(tenant==='a'?'b':'a')+'.marketing-proof.invalid';
 for(const [kind,path] of [['form','/form/'+binding.formsId],['page','/'+binding.pageAlias],['asset',new URL(binding.assetDownloadUrl).pathname]]){
  const own=request(tenant,{host,path}),wrong=request(tenant,{host:foreign,path});
  rows.push({tenant,kind,path,ownStatus:own.status,foreignStatus:wrong.status,ownSha256:createHash('sha256').update(own.body).digest('hex'),foreignSha256:createHash('sha256').update(wrong.body).digest('hex'),foreignBodyEqualsOwn:own.body.equals(wrong.body)});
 }
}
writeFileSync(directory+'publishing/evidence/host-baseline.json',JSON.stringify({capturedAt:new Date().toISOString(),level:'SERVICE direct private native endpoint; no public edge deployed',rows},null,2)+'\n');
assert.ok(rows.every(r=>r.ownStatus===200),'Each positive native fixture must be available');
assert.ok(rows.every(r=>r.foreignStatus>=400&&r.foreignStatus<500),'A tenant endpoint must reject the other tenant Host');
