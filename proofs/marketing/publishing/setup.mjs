import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {docker,directory,prefix,images,context} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {keys} from '../rawcapture/runtime.mjs';
const state=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json'));
const rows=[],hash=value=>createHash('sha256').update(value).digest('hex');
// The intake form is edge-owned and posts only to raw capture; no native Mautic form is involved.
const captureKeys=keys(),fields=[{name:'email',type:'email',label:'Email'},{name:'firstname',type:'text',label:'First name'}];
for(const tenant of ['a','b']){
 const network=prefix+(tenant==='b'?'-tenant-b':''),name=prefix+'-public-'+tenant;
 assert.equal(JSON.parse(docker(['network','inspect',network]))[0].Internal,true);
 const binding=state.tenants[tenant],pageResponse=api(tenant,'/pages/'+binding.publicPagesId),assetResponse=api(tenant,'/assets/'+binding.assetsId);
 for(const response of [pageResponse,assetResponse])assert.equal(response.status,200);
 const page=pageResponse.data.page,asset=assetResponse.data.asset;
 for(const entity of [page,asset])assert.equal(entity.isPublished,true);
 assert.ok(!page.customHtml.includes('{form='),'Use the separate page without native form script');
 const keyPath=directory+'private/publishing/key-'+tenant;if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
 const config={host:'tenant-'+tenant+'.marketing-proof.invalid',key:readFileSync(keyPath,'utf8'),upstream:'http://'+prefix+'-web-'+tenant,form:{id:'intake',title:'Remold intake',fields},capture:{url:'http://capture:3210',key:captureKeys[tenant].edge},routes:[{path:'/'+page.alias,nativePath:'/'+page.alias,contentType:'text/html'},{path:new URL(asset.downloadUrl).pathname,nativePath:new URL(asset.downloadUrl).pathname,contentType:'text/plain'}]};
 let current;try{current=JSON.parse(docker(['inspect',name]))[0];}catch{}
 if(current){assert.equal(current.Config.Labels['remold.fixture'],state.fixture);assert.equal(current.Config.Labels['remold.tenant'],tenant);assert.equal(current.Config.Image,images.mautic);assert.deepEqual(Object.keys(current.NetworkSettings.Networks),[network]);assert.equal(Object.keys(current.HostConfig.PortBindings??{}).length,0);if(current.State.Running)docker(['stop',name]);}
 else docker(['create','--name',name,'--label','remold.proof=marketing','--label','remold.tenant='+tenant,'--label','remold.fixture='+state.fixture,'--network',network,'--memory','64m','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',images.mautic,'/public-server.mjs']);
 const configPath=directory+'private/publishing/config-'+tenant+'.json';writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 docker(['cp',directory+'publishing/server.mjs',name+':/public-server.mjs']);
 // Pin file ownership in the archive: cap-drop ALL prevents root reading a host-owned 0600 copy.
 const archive=execFileSync('python3',['-c',"import io,sys,tarfile; b=open(sys.argv[1],'rb').read(); t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|'); m=tarfile.TarInfo('public-config.json'); m.size=len(b); m.mode=0o400; m.uid=m.gid=0; t.addfile(m,io.BytesIO(b)); t.close()",configPath]);
 execFileSync('docker',['--context',context,'cp','-',name+':/'],{input:archive,stdio:['pipe','pipe','pipe']});docker(['start',name]);
 const inspect=JSON.parse(docker(['inspect',name]))[0];assert.equal(Object.keys(inspect.HostConfig.PortBindings??{}).length,0);
 assert.equal(docker(['exec',name,'sha256sum','/public-server.mjs']).split(' ')[0],hash(readFileSync(directory+'publishing/server.mjs')));
 rows.push({tenant,name,id:inspect.Id,image:inspect.Config.Image,network,host:config.host,publishedPorts:0,memoryBytes:inspect.HostConfig.Memory,serverSha256:hash(readFileSync(directory+'publishing/server.mjs')),formPath:'/form/intake',fieldSchema:fields,captureKeySha256:hash(config.capture.key),routes:config.routes,keySha256:hash(config.key),hasNativeAdminCredential:false});
}
writeFileSync((process.env.REMOLD_PUBLISH_EVIDENCE_DIR??directory+'publishing/evidence/')+'setup.json',JSON.stringify({capturedAt:new Date().toISOString(),level:'SERVICE two internal public-edge sidecars; no host ports/DNS/TLS',rows},null,2)+'\n');
console.log('Two tenant-bound internal edges started; private native APIs stay unexposed.');
