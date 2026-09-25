import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {docker,directory,prefix,images} from '../runtime.mjs';
import {mediaRoot,digest,inspect,manifestCode,volumeManifest,databaseSnapshot} from './media-storage.mjs';
import {api} from './api.mjs';
const state=JSON.parse(readFileSync(directory+'private/tenants/b.json'));
const privateDir=directory+'private/tenants/',journalPath=privateDir+'media-migration.json';
const web=prefix+'-web-b',legacy=web+'-before-media',network=prefix+'-tenant-b';
const owned=value=>{const l=value.Config?.Labels??value.Labels;assert.equal(l?.['remold.proof'],'marketing');assert.equal(l?.['remold.tenant'],'b');assert.equal(l?.['remold.fixture'],state.fixture);};
const find=name=>{try{return inspect(name);}catch{return null;}};
const aSnapshot=()=>['web-a','db-a'].map(n=>{const v=inspect(prefix+'-'+n);return {id:v.Id,networks:Object.keys(v.NetworkSettings.Networks),mounts:v.Mounts.map(m=>({name:m.Name,destination:m.Destination})).sort((a,b)=>a.destination.localeCompare(b.destination))};});
let journal;
function save(){writeFileSync(journalPath+'.tmp',JSON.stringify(journal),{mode:0o600});renameSync(journalPath+'.tmp',journalPath);}
try{
 if(existsSync(journalPath)){journal=JSON.parse(readFileSync(journalPath));assert.equal(journal.fixture,state.fixture);if(journal.phase==='verified'){assert.equal(inspect(web).Id,journal.replacementId);console.log('Migration already recorded as verified; historical evidence preserved. Run media-replay after and isolation-replay for current behavior.');process.exit(0);}}
 else{
  const old=inspect(web);owned(old);assert.equal(old.Config.Image,images.mautic);assert.equal(old.HostConfig.RestartPolicy.Name,'no');assert.equal(find(legacy),null);assert.deepEqual(Object.keys(old.NetworkSettings.Networks),[network]);
  const sources={};for(const kind of ['files','images']){const mount=old.Mounts.find(m=>m.Destination===mediaRoot+'/'+kind);assert.equal(mount?.Type,'volume');assert.equal(mount.Driver,'local');assert.ok(!mount.Name.startsWith(prefix));assert.deepEqual(docker(['ps','-a','--no-trunc','--filter','volume='+mount.Name,'--format','{{.ID}}']).trim().split('\n'),[old.Id]);sources[kind]=mount.Name;}
  const contact=api('b','/contacts/1');assert.equal(contact.status,200);
  journal={fixture:state.fixture,phase:'prepared',old,sources,aBefore:aSnapshot(),databaseBefore:databaseSnapshot(),contactBefore:digest(contact.data),dbId:inspect(prefix+'-db-b').Id,envHash:digest([...old.Config.Env].sort()),copies:{}};
  writeFileSync(journalPath,JSON.stringify(journal),{mode:0o600,flag:'wx'});
 }
 const old=inspect(journal.old.Id);owned(old);assert.equal(old.Id,journal.old.Id);assert.equal(old.Config.Image,images.mautic);
 if(journal.phase==='prepared'){
  if(old.State.Running)docker(['stop',old.Id]);
  assert.equal(inspect(old.Id).State.Running,false);
  if(inspect(old.Id).Name==='/'+web)docker(['rename',old.Id,legacy]);
  assert.equal(inspect(old.Id).Name,'/'+legacy);
  if(inspect(old.Id).NetworkSettings.Networks[network])docker(['network','disconnect',network,old.Id]);
  journal.phase='fenced';save();
 }
 if(journal.phase==='fenced'){
  assert.equal(find(web),null,'Do not copy while a replacement might write');assert.equal(inspect(old.Id).State.Running,false);
  for(const kind of ['files','images']){
   const target=prefix+'-'+kind+'-b';let volume;try{volume=JSON.parse(docker(['volume','inspect',target]))[0];}catch{docker(['volume','create','--label','remold.proof=marketing','--label','remold.tenant=b','--label','remold.fixture='+state.fixture,target]);volume=JSON.parse(docker(['volume','inspect',target]))[0];}owned(volume);
   const sourceManifest=volumeManifest(journal.sources[kind],state.fixture);const destination=volumeManifest(target,state.fixture);
   if(JSON.stringify(destination)!==JSON.stringify(sourceManifest)){
    assert.equal(destination.length,1,'Refuse a partial or unexpected nonempty destination; preserve it for review');
    const result=JSON.parse(docker(['run','--rm','--label','remold.proof=marketing','--label','remold.fixture='+state.fixture,'--network','none','--read-only','--memory','128m','--cap-drop','ALL',...['CHOWN','DAC_OVERRIDE','FOWNER','FSETID'].flatMap(c=>['--cap-add',c]),'--security-opt','no-new-privileges','--mount','type=volume,src='+journal.sources[kind]+',dst=/source,readonly,volume-nocopy','--mount','type=volume,src='+target+',dst=/target,volume-nocopy','--entrypoint','node',images.mautic,'-e',manifestCode+`const before=manifest('/source');if(fs.readdirSync('/target').length)throw Error('Destination changed before copy');require('child_process').execFileSync('cp',['-a','/source/.','/target/']);const after=manifest('/target');require('assert').deepStrictEqual(after,before);console.log(JSON.stringify(after));`]));assert.deepEqual(result,sourceManifest);
   }
   assert.deepEqual(volumeManifest(target,state.fixture),sourceManifest);
   journal.copies[kind]={source:journal.sources[kind],target,manifest:sourceManifest,sha256:digest(sourceManifest)};save();
  }
  journal.phase='copied';save();
 }
 if(journal.phase==='copied'){
  assert.equal(inspect(old.Id).State.Running,false);assert.deepEqual(Object.keys(inspect(old.Id).NetworkSettings.Networks),[]);
  for(const kind of ['files','images']){assert.deepEqual(volumeManifest(journal.sources[kind],state.fixture),journal.copies[kind].manifest);assert.deepEqual(volumeManifest(journal.copies[kind].target,state.fixture),journal.copies[kind].manifest);}
  let next=find(web);
  if(!next){
   assert.ok(journal.old.Config.Env.every(v=>!/[\r\n]/.test(v)));const envPath=privateDir+'media-replacement.env';writeFileSync(envPath,journal.old.Config.Env.join('\n')+'\n',{mode:0o600});
   const aliases=journal.old.NetworkSettings.Networks[network].Aliases.filter(a=>a!==journal.old.Id&&a!==journal.old.Id.slice(0,12)&&a!==web);
   const mounts=journal.old.Mounts.flatMap(m=>{const kind=['files','images'].find(k=>m.Destination===mediaRoot+'/'+k);return ['--mount','type=volume,src='+(kind?journal.copies[kind].target:m.Name)+',dst='+m.Destination+(kind?',volume-nocopy':'')];});
   docker(['create','--name',web,...Object.entries(journal.old.Config.Labels).flatMap(([k,v])=>['--label',k+'='+v]),'--network',network,...aliases.flatMap(a=>['--network-alias',a]),'--memory',String(journal.old.HostConfig.Memory),'--env-file',envPath,...mounts,images.mautic]);next=inspect(web);
  }
  owned(next);assert.equal(next.Config.Image,journal.old.Config.Image);assert.equal(digest([...next.Config.Env].sort()),journal.envHash);assert.deepEqual(next.Config.Entrypoint,journal.old.Config.Entrypoint);assert.deepEqual(next.Config.Cmd,journal.old.Config.Cmd);assert.deepEqual(next.Config.Labels,journal.old.Config.Labels);assert.equal(next.HostConfig.Memory,journal.old.HostConfig.Memory);assert.deepEqual(Object.keys(next.NetworkSettings.Networks),[network]);assert.equal(Object.keys(next.HostConfig.PortBindings??{}).length,0);
  for(const m of journal.old.Mounts){const kind=['files','images'].find(k=>m.Destination===mediaRoot+'/'+k);assert.ok(next.Mounts.some(n=>n.Name===(kind?journal.copies[kind].target:m.Name)&&n.Destination===m.Destination&&n.RW===m.RW));}assert.equal(next.Mounts.length,journal.old.Mounts.length);
  const aliases=v=>v.NetworkSettings.Networks[network].Aliases.filter(a=>![v.Id,v.Id.slice(0,12)].includes(a)).sort();assert.deepEqual(aliases(next),aliases(journal.old));
  journal.replacementId=next.Id;save();if(!next.State.Running)docker(['start',next.Id]);
  for(let n=0;n<60;n++){try{assert.equal(api('b','/contacts/1').status,200);break;}catch(e){if(n===59)throw e;await new Promise(r=>setTimeout(r,1000));}}
  for(const kind of ['files','images'])assert.deepEqual(volumeManifest(journal.copies[kind].target,state.fixture),journal.copies[kind].manifest,'Startup must preserve copied media metadata and bytes');
  assert.equal(databaseSnapshot(),journal.databaseBefore);assert.equal(digest(api('b','/contacts/1').data),journal.contactBefore);assert.equal(inspect(prefix+'-db-b').Id,journal.dbId);assert.deepEqual(aSnapshot(),journal.aBefore);assert.equal(inspect(old.Id).State.Running,false);assert.deepEqual(Object.keys(inspect(old.Id).NetworkSettings.Networks),[]);
  journal.phase='verified';save();
 }
 assert.equal(journal.phase,'verified');
 writeFileSync(directory+'tenants/evidence/media-migration.json',JSON.stringify({status:'PASS',level:'SERVICE B-only media preservation; not full restore',capturedAt:new Date().toISOString(),oldId:journal.old.Id,replacementId:journal.replacementId,legacy,legacyStopped:true,legacyDisconnected:true,databaseAndQueueUnchanged:true,contactUnchanged:true,aContainersAndMountsUnchanged:true,envHash:journal.envHash,configAndRuntimeCompared:true,copies:journal.copies,limits:['A remains on legacy anonymous media volumes','No native asset API or database restore tested','ACLs, xattrs and timestamps not compared','Do not start retained legacy container alongside replacement']},null,2)+'\n');
 console.log('PASS B media copied with exact byte/ownership/mode manifests; original container retained offline, DB/queue/contact and A unchanged.');
}catch(error){writeFileSync(privateDir+'media-migration-error.log',String(error.stderr??error.stack??error),{mode:0o600});throw Error('Media migration stopped without deleting retained data; inspect private journal and error before resuming.');}
