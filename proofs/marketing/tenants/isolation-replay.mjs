import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {docker,directory,prefix} from '../runtime.mjs';
import {api} from './api.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const a=JSON.parse(readFileSync(directory+'private/runtime.json')),b=JSON.parse(readFileSync(directory+'private/tenants/b.json'));
assert.notEqual(a.adminPassword,b.adminPassword);assert.notEqual(a.dbPassword,b.dbPassword);
const ok=(r)=>{assert.ok(r.status>=200&&r.status<300,'Native API must return a success status, including201 for creation');return r.data;};
const first=Object.values(ok(api('a','/contacts?limit=1&orderBy=id&orderByDir=ASC')).contacts)[0];assert.ok(first);assert.match(first.fields.all.email,/@example\.invalid$/,'Use only an existing synthetic A contact');
const aContactBefore=ok(api('a','/contacts/'+first.id)).contact;
const statePath=directory+'private/tenants/isolation.json',saved=existsSync(statePath)?JSON.parse(readFileSync(statePath)):null;
if(saved){assert.equal(saved.fixture,b.fixture);assert.equal(saved.aContact,first.id);}
if(!saved)assert.equal(Object.values(ok(api('b','/contacts?limit=1')).contacts).length,0,'Existing B contacts require an explicit fixture binding; never silently adopt');
const marker='Tenant B '+randomUUID().slice(0,8);
let bContact=saved?ok(api('b','/contacts/'+saved.bContact)).contact:ok(api('b','/contacts/new','POST',{email:first.fields.all.email,firstname:marker})).contact;
assert.equal(bContact.id,first.id,'This fixture requires the same numeric contact ID in two actual instances');
if(saved)bContact=ok(api('b','/contacts/'+bContact.id+'/edit','PATCH',{firstname:marker})).contact;
assert.equal(bContact.fields.all.email,first.fields.all.email);assert.equal(bContact.fields.all.firstname,marker);assert.notEqual(bContact.fields.all.firstname,aContactBefore.fields.all.firstname);
let email=saved?.email;
if(!email)email=ok(api('b','/emails/new','POST',{name:'B local queue isolation',subject:'B isolation fixture',emailType:'template',isPublished:true,template:'blank',customHtml:'<html><body>Local B queue only.</body></html>',plainText:'Local B queue only.',fromAddress:'synthetic-sender@example.invalid',fromName:'Synthetic B proof'})).email.id;
writeFileSync(statePath,JSON.stringify({fixture:b.fixture,aContact:first.id,bContact:bContact.id,email}),{mode:0o600});
const cross=[api('b','/contacts/'+bContact.id,'GET',undefined,a.adminPassword),api('a','/contacts/'+first.id,'GET',undefined,b.adminPassword),api('b','/contacts/'+bContact.id,'GET',undefined,'')];
for(const r of cross){assert.ok([401,403].includes(r.status),'Foreign or empty credentials must fail');assert.ok(!r.data?.contact,'Refused request must not return contact data');}
const sql=(tenant,q)=>docker(['exec',prefix+'-db-'+tenant,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
const queue=tenant=>sql(tenant,"SHOW TABLES LIKE 'messenger_messages'")?sql(tenant,'SELECT id,queue_name,SHA2(body,256),created_at,available_at,COALESCE(delivered_at,\'NULL\') FROM messenger_messages ORDER BY id').split('\n').filter(Boolean):[];
const aQueueBefore=queue('a'),bQueueBefore=queue('b');assert.ok(bQueueBefore.length<128,'Retain the bounded queue; never clear it to pass');
ok(api('b','/emails/'+email+'/contact/'+bContact.id+'/send','POST',{}));
const bQueueAfter=queue('b');assert.equal(bQueueAfter.length,bQueueBefore.length+1,'B API send must persist one B queue row');assert.deepEqual(queue('a'),aQueueBefore,'B queue write cannot change A queue');
const inspect=name=>JSON.parse(docker(['inspect',prefix+'-'+name]))[0],webA=inspect('web-a'),webB=inspect('web-b');
assert.deepEqual(Object.keys(webB.NetworkSettings.Networks),[prefix+'-tenant-b']);assert.ok(!Object.keys(webA.NetworkSettings.Networks).includes(prefix+'-tenant-b'));assert.equal(Object.keys(webB.HostConfig.PortBindings??{}).length,0);
const aVolumes=new Set(['web-a','db-a'].flatMap(n=>inspect(n).Mounts.map(m=>m.Name)));for(const n of ['web-b','db-b'])for(const m of inspect(n).Mounts){assert.equal(m.Type,'volume');assert.ok(!aVolumes.has(m.Name),'A and B cannot share a persistent volume');}
const aIp=Object.values(webA.NetworkSettings.Networks)[0].IPAddress;
const networkResult=JSON.parse(docker(['exec',prefix+'-web-b','node','--input-type=module','-e',`try{const r=await fetch('http://'+process.argv[1],{redirect:'manual',signal:AbortSignal.timeout(2000)});console.log(JSON.stringify({reachable:true,status:r.status}));}catch(e){console.log(JSON.stringify({reachable:false,error:e.cause?.code??e.name}));}`,aIp]));assert.equal(networkResult.reachable,false,'B network must not reach A private web endpoint');
for(const n of ['db-b','web-b']){const v=inspect(n);assert.equal(v.Config.Labels['remold.fixture'],b.fixture);docker(['restart',prefix+'-'+n]);}
for(let n=0;n<30;n++){try{assert.equal(sql('b','SELECT 1'),'1');assert.equal(api('b','/contacts/'+bContact.id).status,200);break;}catch(e){if(n===29)throw e;await new Promise(r=>setTimeout(r,1000));}}
assert.deepEqual(queue('b'),bQueueAfter,'B queue must survive database/web restart');assert.deepEqual(queue('a'),aQueueBefore);assert.deepEqual(ok(api('a','/contacts/'+first.id)).contact,aContactBefore,'B work must leave the A contact unchanged');assert.equal(ok(api('b','/contacts/'+bContact.id)).contact.fields.all.firstname,marker);
const baseline=JSON.parse(readFileSync(directory+'tenants/evidence/baseline.json'));
if(existsSync(directory+'private/tenants/media-migration.json')){const legacy=inspect('web-b-before-media');assert.equal(legacy.State.Running,false);assert.deepEqual(Object.keys(legacy.NetworkSettings.Networks),[]);}
for(const old of baseline.containers){const now=JSON.parse(docker(['inspect',old.name]))[0];assert.equal(now.Id,old.id);assert.deepEqual(Object.keys(now.NetworkSettings.Networks),old.networks);const sort=v=>[...v].sort((a,b)=>a.destination.localeCompare(b.destination));assert.deepEqual(sort(now.Mounts.map(m=>({type:m.Type,name:m.Name,destination:m.Destination}))),sort(old.volumes));}
writeFileSync((process.env.REMOLD_TENANT_EVIDENCE_DIR??directory+'tenants/evidence/')+'isolation.json',JSON.stringify({status:'PASS',level:'SERVICE two actual Mautic/MySQL instances; B mail still disabled/null, no delivery proof',capturedAt:new Date().toISOString(),sameContactId:first.id,sameEmail:true,distinctFieldValues:true,foreignCredentialStatuses:cross.map(r=>r.status),aContactHash:hash(aContactBefore),aContactUnchanged:true,aQueueUnchanged:true,aQueueHash:hash(aQueueBefore),bQueueRowsBefore:bQueueBefore.length,bQueueRowsAfter:bQueueAfter.length,bQueueHash:hash(bQueueAfter),bQueueSurvivedRestart:true,aContainerIdentityAndMountsUnchanged:true,separateVolumes:true,separateInternalNetworks:true,bCanReachA:false,bNetworkFailure:networkResult.error,bPublishedPorts:0,noBWorkerRun:true,limits:['No B dispatch-permit or MIME transport proof yet','No tenant-bound public form/page/media/callback routing yet','No sync/consent/recovery/upgrade/native-comparison/full P2 certification']},null,2)+'\n');
console.log('PASS same-ID/same-email contacts stay distinct; cross credentials refuse; B cannot reach A; separate B queue survives restart with A unchanged.');
