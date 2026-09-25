import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {authority,authorityEnvironment} from './authority.mjs';
import {docker,directory,prefix,images} from './runtime.mjs';
import {mautic} from './api.mjs';
let existing=false;try{docker(['container','inspect',prefix+'-bridge']);existing=true;}catch{}
if(existing&&!process.argv.includes('--rearm'))throw Error('Bridge already exists; explicit --rearm required for a new isolated fixture');
if(existing){writeFileSync(directory+'private/bridge-config-'+Date.now()+'.json',readFileSync(directory+'private/bridge-config.json'),{mode:0o600});docker(['stop',prefix+'-bridge']);}
try{execFileSync(process.execPath,[directory+'../../node_modules/convex/bin/main.js','dev','--once','--typecheck','enable'],{cwd:directory,env:authorityEnvironment(),stdio:'pipe'});}catch(e){writeFileSync(directory+'private/authority-deploy.log',String(e.stderr??'Local deploy failed'),{mode:0o600});throw Error('Isolated authority deployment failed; private log retained');}
const native=JSON.parse(readFileSync(directory+'private/native-fixture.json')),runtime=JSON.parse(readFileSync(directory+'private/runtime.json'));
const fixture=authority('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
authority('marketingFixture:bindContact',{binding:fixture.A.binding,externalId:String(native.contact)});
authority('harness:grant',{token:fixture.A.sessions.owner,target:fixture.A.actors.child,capability:'marketing.send',scope:{kind:'bindings',bindings:[fixture.A.binding],maxAmountMinor:0,currency:'usd',maxRecipients:1},mode:'propose',delegate:false,expires:Date.now()+3600000});
const contact=(await mautic('/contacts/'+native.contact)).contact;
const config={fixture,contact:native.contact,events:native.events.filter(e=>e.type==='email.send').map(e=>e.id),recipient:contact.fields.all.email,workflowVersion:1,bridgeKey:runtime.bridgeKey,killAfterConsume:process.argv.includes('--kill-after-consume'),sinkRefusedOnce:process.argv.includes('--sink-refused-once'),sinkBusyOnce:process.argv.includes('--sink-busy-once'),lostSinkResponseOnce:process.argv.includes('--lost-sink-response-once')};
writeFileSync(directory+'private/bridge-config.json',JSON.stringify(config),{mode:0o600});
const f=fixture.A;
const engineConfig={...config,fixture:{A:{binding:f.binding,key:f.key,adapter:f.adapter,sessions:{child:f.sessions.child}}}};
if(JSON.stringify(engineConfig).includes(f.sessions.owner))throw Error('Owner credential crossed engine boundary');
writeFileSync(directory+'private/engine-config.json',JSON.stringify(engineConfig),{mode:0o600});
const volume=prefix+'-bridge';try{docker(['volume','inspect',volume]);}catch{docker(['volume','create','--label','remold.proof=marketing',volume]);}
if(!existing)docker(['create','--name',prefix+'-bridge','--label','remold.proof=marketing','--network',prefix,'--network-alias','bridge','--memory','128m','-p','127.0.0.1:3542:3542','--mount','type=volume,src='+volume+',dst=/data','--entrypoint','node',images.mautic,'/bridge.mjs']);
docker(['cp',directory+'bridge.mjs',prefix+'-bridge:/bridge.mjs']);
docker(['cp',directory+'private/engine-config.json',prefix+'-bridge:/config.json']);
docker(['start',prefix+'-bridge']);
console.log('Synthetic fixture authority and isolated durable bridge configured.');
