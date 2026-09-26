import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {scope,assertBackend,convexEnvironment} from './policy.mjs';
import {load,save} from './state.mjs';
import {api} from './backend.mjs';
try {
 const {dir,receipt,plan}=load(process.argv[2]);assert.equal(receipt.phase,'backend-attempted');assert.equal(receipt.backendAbsentBefore,true);
 const url=new URL(process.env.PREVIEW_CONVEX_URL);assert.equal(url.protocol,'https:');assert(/^[a-z][a-z0-9-]+\.convex\.cloud$/.test(url.hostname));
 const key=process.env.CONVEX_DEPLOY_KEY;assert.equal(process.env.CONVEX_OVERRIDE_ACCESS_TOKEN,key);
 const name=url.hostname.slice(0,-'.convex.cloud'.length);
 const metadata=await api(`/deployments/${name}`,key);
 const backend=Object.fromEntries(['id','name','createTime','projectId','deploymentType','kind','isDefault','reference','previewIdentifier','deploymentUrl','expiresAt'].map(k=>[k,metadata[k]]));
 assertBackend(plan,backend);assert(backend.createTime>=Date.parse(receipt.attemptedAt)-5000,'Unexpected older backend');
 receipt.backend=backend;save(dir,receipt);
 const cli=join(receipt.checkout,'node_modules/.bin/convex'),env=convexEnvironment(process.env,key);
 const set=spawnSync(cli,['env','set','WORKOS_CLIENT_ID',scope.clientId,'--preview-name',plan.name],{cwd:receipt.checkout,env,encoding:'utf8'});assert.equal(set.status,0,'Setting staging client ID failed');
 const get=spawnSync(cli,['env','get','WORKOS_CLIENT_ID','--preview-name',plan.name],{cwd:receipt.checkout,env,encoding:'utf8'});assert.equal(get.status,0);assert.equal(get.stdout.trim(),scope.clientId);
 receipt.clientIdVerified=true;save(dir,receipt);console.log('Verified staging client ID before first backend push.');
} catch(e) {console.error(e.message);process.exitCode=1;}
