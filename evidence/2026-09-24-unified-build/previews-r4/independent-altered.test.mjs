import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {candidateHeads,previewPlan,scope,assertBackendRecovery,assertFrontendReplacement,cleanupPlan} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/ops/previews/policy.mjs';
const w=JSON.parse(readFileSync('/Users/urkel/Documents/CodeMyVibe/Projects/remold/evidence/2026-09-24-unified-build/previews-reconciliation/independent-metadata.json')).relevantPreviewMatches[0];
const p3=previewPlan(3,candidateHeads[3]),p4=previewPlan(4,candidateHeads[4]),at='2026-09-25T01:19:23.976Z',r={phase:'backend-attempted',backend:null,backendAbsentBefore:true,attemptedAt:at};
test('recovery window boundaries',()=>{
 assertBackendRecovery(p3,r,{...w,createTime:Date.parse(at)-5000},w.name,w.id);
 assertBackendRecovery(p3,r,{...w,createTime:Date.parse(at)+600000},w.name,w.id);
 assert.throws(()=>assertBackendRecovery(p3,r,{...w,createTime:Date.parse(at)-5001},w.name,w.id));
 assert.throws(()=>assertBackendRecovery(p3,r,{...w,createTime:Date.parse(at)+600001},w.name,w.id));
});
test('recovery refuses altered identity or wrong PR',()=>{
 for(const c of [{previewIdentifier:null},{previewIdentifier:'pr-4'},{isDefault:true},{deploymentType:'prod'},{projectId:1},{deploymentUrl:'https://x.convex.cloud'},{kind:'local'}])assert.throws(()=>assertBackendRecovery(p3,r,{...w,...c},w.name,w.id),JSON.stringify(c));
 assert.throws(()=>assertBackendRecovery(p4,r,w,w.name,w.id));
 assert.throws(()=>assertBackendRecovery(p3,r,w,w.name,String(w.id)));
 assert.throws(()=>assertBackendRecovery(p3,r,w,w.name,NaN));
 assert.throws(()=>assertBackendRecovery(p3,{...r,backend:undefined},w,w.name,w.id),'missing backend field is not null');
 assert.throws(()=>assertBackendRecovery(p3,{...r,backendAbsentBefore:undefined},w,w.name,w.id));
});
test('replacement refuses extra fields, other PR, and missing ownership',()=>{
 const cur={id:'567c0b1448364e4786f2bafb238b372d',name:'pr-4',worker:scope.worker,accountId:scope.accountId},rec={cloudflare:{...cur,absentBefore:true}};
 assertFrontendReplacement(p4,rec,cur,cur.id);
 assert.throws(()=>assertFrontendReplacement(p4,rec,{...cur,extra:1},cur.id));
 assert.throws(()=>assertFrontendReplacement(p3,rec,cur,cur.id));
 assert.throws(()=>assertFrontendReplacement(p4,{},cur,cur.id));
 assert.throws(()=>assertFrontendReplacement(p4,rec,cur,undefined));
 assert.throws(()=>assertFrontendReplacement(p4,rec,{...cur,name:'pr-3'},cur.id));
});
test('actual PR4 receipt satisfies replacement and cleanup still targets same ID',()=>{
 const rec=JSON.parse(readFileSync('/private/var/folders/9g/lc9sprl94dl4d7x2lvtbspc80000gn/T/remold-i2-preview-b-b703lrnx/prepared/receipt.json'));
 const cur={id:rec.cloudflare.id,name:'pr-4',worker:scope.worker,accountId:scope.accountId};
 assertFrontendReplacement(p4,rec,cur,'567c0b1448364e4786f2bafb238b372d');
 assert.throws(()=>assertFrontendReplacement(p4,rec,{...cur,id:'new'},'567c0b1448364e4786f2bafb238b372d'));
 const plan=cleanupPlan(p4,rec,rec.backend,{clientId:scope.clientId,redirectUris:[],corsOrigins:[]},cur);
 assert.equal(plan.cloudflare.id,'567c0b1448364e4786f2bafb238b372d');
});
test('actual PR3 receipt admits exactly neat-squid-188 5678975',()=>{
 const rec=JSON.parse(readFileSync('/private/var/folders/9g/lc9sprl94dl4d7x2lvtbspc80000gn/T/remold-i2-preview-a-xcxovlze/prepared/receipt.json'));
 assertBackendRecovery(p3,rec,w,'neat-squid-188',5678975);
 assert.throws(()=>assertBackendRecovery(p3,{...rec,phase:'backend-recovery-attempted'},w,'neat-squid-188',5678975));
});
