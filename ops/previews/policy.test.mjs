import {readFileSync} from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {scope,previewPlan,previewConfig,assertPreviewConfig,childEnvironment,workosChange,cleanupPlan} from './policy.mjs';
const a=previewPlan(101), b=previewPlan(102);
const before={clientId:scope.clientId,redirectUris:['http://localhost:5173/callback',b.callback],corsOrigins:['http://localhost:5173',b.origin],homepage:'http://localhost:5173',defaultRedirect:'http://localhost:5173/callback'};
const backend={id:7,projectId:scope.projectId,deploymentType:'preview',kind:'cloud',isDefault:false,reference:'provider-reference',previewIdentifier:a.name,name:'synthetic-pika-123',deploymentUrl:'https://synthetic-pika-123.convex.cloud',createTime:123};
const added=workosChange(a,before,'add');
const cf={accountId:scope.accountId,worker:scope.worker,name:a.name,id:'cf-preview-7',createdOn:'2026-09-25T00:00:00Z'};
const receipt={plan:a,backend,backendAbsentBefore:true,workosOwned:added.owned,cloudflare:{...cf,absentBefore:true}};
test('two PR plans have distinct stable origins while retaining one staging identity realm',()=>{assert.notEqual(a.origin,b.origin);assert.notEqual(a.name,b.name);assert.equal(a.clientId,b.clientId);assert.throws(()=>previewPlan(0));assert.throws(()=>previewPlan(101,'a'.repeat(40)));});
test('preview configuration cannot carry production routes, bindings or another account',()=>{const c=previewConfig('/tmp/sealed-preview');assertPreviewConfig(c);for(const bad of [{...c,routes:[{pattern:'app.remoldcrm.com'}]},{...c,services:[{binding:'PROD',service:'remold'}]},{...c,account_id:'other'},{...c,previews:{vars:{SECRET:'bad'}}},{...c,assets:{...c.assets,directory:'./artifact'}}])assert.throws(()=>assertPreviewConfig(bad));});
test('child environment drops inherited production targets and provider secrets',()=>{const env=childEnvironment({PATH:'/bin',HOME:'/home/fixture',CONVEX_DEPLOYMENT:'prod:bad',CONVEX_SELF_HOSTED_URL:'https://wrong.invalid',WORKOS_API_KEY:'secret',CLOUDFLARE_API_TOKEN:'other',VITE_CONVEX_URL:'https://wrong.invalid'});assert.deepEqual(env,{PATH:'/bin',HOME:'/home/fixture',WRANGLER_SEND_METRICS:'false',CI:'1'});assert.throws(()=>childEnvironment({}, {CLOUDFLARE_API_TOKEN:'bad'}));});
test('AuthKit add preserves existing origins, homepage and default; repeated add is idempotent',()=>{assert.deepEqual(added.redirectUris,[...before.redirectUris,a.callback]);assert.equal(added.homepage,before.homepage);assert.equal(added.defaultRedirect,before.defaultRedirect);assert.deepEqual(workosChange(a,added,'add').redirectUris,added.redirectUris);assert.throws(()=>workosChange(a,{...before,clientId:'client_wrong'},'add'));});
test('close A removes only its owned entries and exact backend; B and concurrent additions survive',()=>{const current={...added,redirectUris:[...added.redirectUris,'https://other.invalid/callback'],corsOrigins:[...added.corsOrigins,'https://other.invalid']};const closed=cleanupPlan(a,receipt,backend,current,cf);assert.deepEqual(closed.workos.redirectUris,[...before.redirectUris,'https://other.invalid/callback']);assert.deepEqual(closed.workos.corsOrigins,[...before.corsOrigins,'https://other.invalid']);assert.equal(closed.workos.homepage,before.homepage);assert.equal(closed.convex.path,'/deployments/synthetic-pika-123/delete');assert.equal(closed.cloudflare.preview,'pr-101');});
test('cleanup never removes AuthKit entries that predated this receipt',()=>{const existing=workosChange(a,added,'add');const closed=cleanupPlan(a,{...receipt,workosOwned:existing.owned},backend,added,cf);assert(closed.workos.redirectUris.includes(a.callback));assert(closed.workos.corsOrigins.includes(a.origin));});
test('cleanup refuses wrong tenant, prod, reused backend name, changed identity or another PR receipt',()=>{for(const change of [{projectId:99},{deploymentType:'prod'},{previewIdentifier:b.name},{id:8},{createTime:124},{isDefault:true}])assert.throws(()=>cleanupPlan(a,receipt,{...backend,...change},added,cf));assert.throws(()=>cleanupPlan(b,receipt,backend,added,cf));});
test('an already absent exact backend does not generate another deletion',()=>{assert.equal(cleanupPlan(a,receipt,null,added,cf).convex,null);});

test('resuming an owned AuthKit add retains ownership for later cleanup',()=>{const resumed=workosChange(a,added,'add',added.owned);assert.deepEqual(resumed.owned,added.owned);assert(!cleanupPlan(a,{...receipt,workosOwned:resumed.owned},backend,resumed,cf).workos.redirectUris.includes(a.callback));});
test('cleanup refuses a pre-existing or replaced Cloudflare preview',()=>{
  const cf={accountId:scope.accountId,worker:scope.worker,name:a.name,id:'cf-preview-7',createdOn:'2026-09-25T00:00:00Z'};
  assert.throws(()=>cleanupPlan(a,{...receipt,cloudflare:{...cf,absentBefore:false}},backend,added,cf));
  assert.throws(()=>cleanupPlan(a,{...receipt,cloudflare:{...cf,absentBefore:true}},backend,added,{...cf,id:'other'}));
});
test('Convex child uses the same project preview key for selection and authorization',async()=>{
 const {convexEnvironment}=await import('./policy.mjs');const key=`preview:${scope.team}:${scope.project}|synthetic-key`;
 const env=convexEnvironment({HOME:'/fixture-owner',CONVEX_OVERRIDE_ACCESS_TOKEN:'inherited-personal-token'},key);
 assert.equal(env.HOME,'/fixture-owner');assert.equal(env.CONVEX_DEPLOY_KEY,key);assert.equal(env.CONVEX_OVERRIDE_ACCESS_TOKEN,key);assert.throws(()=>convexEnvironment({},'prod:wrong|key'));
});

test('cleanup refuses false or missing backend absence ownership',()=>{for(const backendAbsentBefore of [false,undefined])assert.throws(()=>cleanupPlan(a,{...receipt,backendAbsentBefore},backend,added,cf),/backend is not owned/);assert.equal(cleanupPlan(a,receipt,backend,added,cf).convex.path,'/deployments/synthetic-pika-123/delete');});


test('provider detail with null identifier is reconciled only with its exact project-list identity',async()=>{
 const {reconcileBackend}=await import('./policy.mjs');
 const witness=JSON.parse(readFileSync(new URL('../../evidence/2026-09-24-unified-build/previews-reconciliation/independent-metadata.json',import.meta.url)));
 const plan=previewPlan(3), detail=witness.metadata, listed=witness.relevantPreviewMatches[0];
 assert.deepEqual(reconcileBackend(plan,detail,[listed]),listed);
 assert.deepEqual(reconcileBackend(plan,listed,[listed]),listed);
 for(const rows of [[],[listed,listed],[{...listed,id:listed.id+1}],[{...listed,createTime:listed.createTime+1}],[{...listed,previewIdentifier:'pr-4'}],[{...listed,reference:'preview/pr-4'}]])assert.throws(()=>reconcileBackend(plan,detail,rows));
 for(const change of [{previewIdentifier:'pr-4'},{reference:'preview/pr-4'},{projectId:99},{deploymentType:'prod'},{isDefault:true},{name:'other-preview'},{deploymentUrl:'https://other.convex.cloud'},{kind:'local'}])assert.throws(()=>reconcileBackend(plan,{...detail,...change},[listed]));
});

test('Wrangler progress output binds the actual preview identity and exact candidate before ownership',async()=>{
 const {frontendReceipt}=await import('./policy.mjs');
 const plan={...previewPlan(4),sha:'c666909bfe07af46732a56671858b65f748a4744'},stdout=readFileSync(new URL('../../evidence/2026-09-24-unified-build/previews-reconciliation/r3/pr4-frontend-deploy.log',import.meta.url),'utf8');
 const current={id:'567c0b1448364e4786f2bafb238b372d',name:plan.name,worker:scope.worker,accountId:scope.accountId};
 assert.deepEqual(frontendReceipt(plan,stdout,current),{...current,absentBefore:true});
 const parsed=JSON.parse(stdout.slice(stdout.indexOf('\n{')+1));
 for(const update of [v=>v.preview.id='other',v=>v.preview.name='pr-3',v=>v.preview.urls=['https://other.invalid'],v=>v.deployment.annotations['workers/message']='wrong commit']){
  const v=structuredClone(parsed);update(v);assert.throws(()=>frontendReceipt(plan,JSON.stringify(v),current));
 }
 for(const text of ['',stdout+'trailing garbage',stdout+'\n{}'])assert.throws(()=>frontendReceipt(plan,text,current));
 assert.throws(()=>frontendReceipt(plan,stdout,{...current,id:'replaced'}));
});

test('replacement requires the exact previously owned frontend and refuses a reused name',async()=>{
 const {assertFrontendReplacement}=await import('./policy.mjs');
 const p=previewPlan(4),current={id:'owned-id',name:p.name,worker:scope.worker,accountId:scope.accountId};
 const r={cloudflare:{...current,absentBefore:true}};
 assertFrontendReplacement(p,r,current,'owned-id');
 for(const changed of [{...current,id:'new-id'},{...current,worker:'other'},{...current,accountId:'other'},null])assert.throws(()=>assertFrontendReplacement(p,r,changed,'owned-id'));
 for(const cloudflare of [null,{...current,absentBefore:false},{...current,id:'other',absentBefore:true}])assert.throws(()=>assertFrontendReplacement(p,{cloudflare},current,'owned-id'));
});

test('recovery binds the originally empty attempt to its exact allocation and cannot repeat',async()=>{
 const {assertBackendRecovery}=await import('./policy.mjs');
 const witness=JSON.parse(readFileSync(new URL('../../evidence/2026-09-24-unified-build/previews-reconciliation/independent-metadata.json',import.meta.url)));
 const p=previewPlan(3),b=witness.relevantPreviewMatches[0],r={phase:'backend-attempted',backend:null,backendAbsentBefore:true,attemptedAt:'2026-09-25T01:19:23.976Z'};
 assertBackendRecovery(p,r,b,'neat-squid-188',5678975);
 for(const change of [{phase:'backend-recovery-attempted'},{backend:b},{backendAbsentBefore:false},{clientIdVerified:true},{attemptedAt:'bad'},{attemptedAt:'2026-09-26T00:00:00Z'},{attemptedAt:'2026-09-24T00:00:00Z'}])assert.throws(()=>assertBackendRecovery(p,{...r,...change},b,'neat-squid-188',5678975));
 assert.throws(()=>assertBackendRecovery(p,r,b,'other',5678975));assert.throws(()=>assertBackendRecovery(p,r,b,'neat-squid-188',123));
});

test('Cloudflare recognizes an absent preview but refuses an absent shared parent',async t=>{
 const {cfPreview}=await import('./frontend.mjs');
 for(const code of [10025]){
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({success:false,result:null,errors:[{code}]}),{status:404}));
  assert.equal(await cfPreview(previewPlan(3),'synthetic'),null);mock.mock.restore();
 }
 for(const [status,code] of [[403,10025],[404,10007],[404,12345],[500,10007]]){
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({success:false,errors:[{code}]}),{status}));
  await assert.rejects(cfPreview(previewPlan(3),'synthetic'));mock.mock.restore();
 }
});
