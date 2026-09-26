import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {directory,docker,prefix,images,context} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
const privateDir=directory+'private/callbacks/',out=directory+'capture/evidence/';mkdirSync(privateDir,{recursive:true,mode:0o700});
const fixture=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')).fixture,rows=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const tenant of ['a','b']){
 const name=prefix+'-callback-'+tenant,network=prefix+(tenant==='b'?'-tenant-b':''),volume=name+'-data',configPath=privateDir+tenant+'.json';
 assert.equal(JSON.parse(docker(['network','inspect',network]))[0].Internal,true);
 if(!existsSync(configPath))writeFileSync(configPath,JSON.stringify({tenant,key:randomBytes(32).toString('hex'),database:'/data/receipts.sqlite'}),{mode:0o600,flag:'wx'});
 const config=JSON.parse(readFileSync(configPath));assert.equal(config.tenant,tenant);
 let current;try{current=JSON.parse(docker(['inspect',name]))[0];}catch{}
 if(current){assert.equal(current.Config.Labels['remold.fixture'],fixture);assert.equal(current.Config.Image,images.mautic);assert.deepEqual(Object.keys(current.NetworkSettings.Networks),[network]);assert.equal(Object.keys(current.HostConfig.PortBindings??{}).length,0);if(current.State.Running)docker(['stop',name]);}
 else{
  let oldVolume;try{oldVolume=JSON.parse(docker(['volume','inspect',volume]))[0];}catch{}
  if(oldVolume)assert.equal(oldVolume.Labels['remold.fixture'],fixture);else docker(['volume','create','--label','remold.fixture='+fixture,volume]);
  docker(['create','--name',name,'--label','remold.proof=marketing','--label','remold.fixture='+fixture,'--label','remold.tenant='+tenant,'--network',network,'--memory','64m','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=volume,source='+volume+',target=/data','--entrypoint','node',images.mautic,'/callback-receiver.mjs']);
 }
 docker(['cp',directory+'capture/receiver.mjs',name+':/callback-receiver.mjs']);
 const tar=execFileSync('python3',['-c',"import io,sys,tarfile; b=open(sys.argv[1],'rb').read(); t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|'); m=tarfile.TarInfo('callback-config.json'); m.size=len(b); m.mode=0o400; m.uid=m.gid=0; t.addfile(m,io.BytesIO(b)); t.close()",configPath]);
 execFileSync('docker',['--context',context,'cp','-',name+':/'],{input:tar,stdio:['pipe','pipe','pipe']});docker(['start',name]);
 const hookPath=privateDir+'hook-'+tenant+'.json',url='http://'+name+':8080/callback';let hook;
 if(existsSync(hookPath)){hook=JSON.parse(readFileSync(hookPath));const r=api(tenant,'/hooks/'+hook.id);assert.equal(r.status,200);assert.equal(r.data.hook.webhookUrl,url);}
 else{
  const inventory=api(tenant,'/hooks?limit=100');assert.equal(inventory.status,200);assert.equal(Number(inventory.data.total),0,'Unjournaled hooks require reconciliation, never create twice');
  const response=api(tenant,'/hooks/new','POST',{name:'Remold callback proof '+fixture+' '+tenant,webhookUrl:url,secret:config.key,isPublished:true,triggers:['mautic.form_on_submit']});
  writeFileSync(privateDir+'hook-response-'+tenant+'.json',JSON.stringify(response),{mode:0o600,flag:'wx'});assert.equal(response.status,201);hook=response.data.hook;assert.ok(hook.id);writeFileSync(hookPath,JSON.stringify(hook),{mode:0o600,flag:'wx'});
 }
 const inspected=JSON.parse(docker(['inspect',name]))[0];rows.push({tenant,name,id:inspected.Id,network,volume,image:images.mautic,memoryBytes:inspected.HostConfig.Memory,publishedPorts:0,hookId:hook.id,url,serverSha256:hash(readFileSync(directory+'capture/receiver.mjs')),keySha256:hash(config.key)});
}
writeFileSync(out+'receiver-setup.json',JSON.stringify({at:new Date().toISOString(),level:'SERVICE isolated receivers and owned native hooks; private-address allowances not changed',rows},null,2)+'\n');
console.log('Two isolated callback receivers and native form hooks installed; private-address delivery remains blocked until its baseline is recorded.');
