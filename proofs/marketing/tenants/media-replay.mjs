import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {docker,directory,prefix,images} from '../runtime.mjs';

const phase=process.argv[2];assert.ok(['before','after'].includes(phase));
const state=JSON.parse(readFileSync(directory+'private/tenants/b.json'));
const markerPath=directory+'private/tenants/media-marker.json';
const web=prefix+'-web-b',root='/var/www/html/docroot/media';
const inspect=name=>JSON.parse(docker(['inspect',name]))[0];
const current=inspect(web);assert.equal(current.Config.Labels['remold.fixture'],state.fixture);
let marker;
if(existsSync(markerPath)){marker=JSON.parse(readFileSync(markerPath));assert.equal(marker.fixture,state.fixture);}
else{
 assert.equal(phase,'before','Never create a replacement marker after migration');
 const name='remold-retention-'+randomUUID()+'.txt',body='Synthetic retained media '+randomUUID()+'\n';
 marker={fixture:state.fixture,name,sha256:createHash('sha256').update(body).digest('hex')};
 docker(['exec','--user','www-data',web,'node','-e',`require('fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx'});`,root+'/files/'+name,body]);
 writeFileSync(markerPath,JSON.stringify(marker),{mode:0o600,flag:'wx'});
}
const path=root+'/files/'+marker.name;
const actual=docker(['exec',web,'sha256sum',path]).split(' ')[0];assert.equal(actual,marker.sha256,'Original marker must exist before probing replacement');
const mounts=[{name:prefix+'-media-b',destination:root}];
if(phase==='after'){for(const kind of ['files','images'])mounts.push({name:prefix+'-'+kind+'-b',destination:root+'/'+kind});assert.equal(current.Mounts.length,5);assert.ok(current.Mounts.every(m=>m.Type==='volume'&&m.Name.startsWith(prefix+'-')));}
for(const mount of mounts)assert.ok(current.Mounts.some(m=>m.Name===mount.name&&m.Destination===mount.destination),'Probe must reflect the current declared media layout');
const probe=prefix+'-media-probe-'+phase+'-'+randomUUID().slice(0,8);
const id=docker(['create','--name',probe,'--label','remold.proof=marketing','--label','remold.tenant=b','--label','remold.fixture='+state.fixture,'--network','none','--read-only','--memory','128m','--cap-drop','ALL','--security-opt','no-new-privileges',...mounts.flatMap(m=>['--mount','type=volume,src='+m.name+',dst='+m.destination+',readonly,volume-nocopy']),'--entrypoint','sh',images.mautic,'-c','test -f "$1" && sha256sum "$1"','--',path]).trim();
docker(['start',probe]);docker(['wait',probe]);
const stopped=inspect(probe),output=docker(['logs',probe]).trim();
const retained=stopped.State.ExitCode===0&&output.split(' ')[0]===marker.sha256;
const result={phase,level:'SERVICE filesystem marker; not native asset API or full restore',capturedAt:new Date().toISOString(),fixture:state.fixture,originalMarkerSha256:marker.sha256,originalMarkerPresent:true,probe,id,image:images.mautic,network:'none',probeExitCode:stopped.State.ExitCode,retained,declaredMounts:mounts,actualMounts:stopped.Mounts.map(m=>({name:m.Name,destination:m.Destination})),webContainerUnchangedDuringProbe:inspect(web).Id===current.Id,probeRetainedForReview:true};
writeFileSync((process.env.REMOLD_TENANT_EVIDENCE_DIR??directory+'tenants/evidence/')+'media-'+phase+'.json',JSON.stringify(result,null,2)+'\n');
assert.equal(retained,true,'Declared replacement layout must retain the original media marker');
console.log('PASS replacement layout retains original media bytes.');
