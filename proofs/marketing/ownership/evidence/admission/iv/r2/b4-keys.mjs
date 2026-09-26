// IV r2 check 4: where do the raw secrets appear? Reports only locations and secret names, never values.
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as L from './lib2.mjs';
const priv=L.directory+'private/',st=JSON.parse(readFileSync(priv+'rawcapture/state.json'));
const secrets={'edge-a':L.K.a.edge,'edge-b':L.K.b.edge,'reconciler-a':L.K.a.reconciler,'reconciler-b':L.K.b.reconciler,'admin-key':st.adminKey,'instance-secret':st.instanceSecret,'form-hmac-a':readFileSync(priv+'publishing/key-a','utf8').trim(),'form-hmac-b':readFileSync(priv+'publishing/key-b','utf8').trim()};
const find=text=>Object.entries(secrets).filter(([,v])=>v&&text.includes(v)).map(([k])=>k);
const out={docker:{},logs:{},containerFiles:{},hostFiles:{},hashesStored:{}};
const containers=L.docker(['ps','-a','--filter','label=remold.proof=marketing','--format','{{.Names}}']).trim().split('\n').concat([L.prefix+'-web-a',L.prefix+'-web-b',L.prefix+'-db-a',L.prefix+'-db-b']);
for(const c of [...new Set(containers)]){
 try{const hit=find(L.docker(['inspect',c]));if(hit.length)out.docker[c]=hit;}catch{}
 try{const logs=execFileSync('docker',['--context',L.context,'logs',c],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1<<28});const hit=find(logs);out.logs[c]=hit;}catch(e){out.logs[c]='error';}
}
// Files inside the edges and the capture backend that contain any raw secret.
import {spawnSync} from 'node:child_process';
const scanScript=`let s='';for await(const c of process.stdin)s+=c;const {want,dirs}=JSON.parse(s);const fs=await import('node:fs'),path=await import('node:path');const hits={};const walk=d=>{let st;try{st=fs.lstatSync(d);}catch{return;}if(st.isSymbolicLink())return;if(st.isFile()){if(st.size>8*1024*1024)return;let b;try{b=fs.readFileSync(d);}catch{return;}for(const [k,v] of Object.entries(want))if(b.includes(v))(hits[d]??=[]).push(k);return;}if(!st.isDirectory())return;let e;try{e=fs.readdirSync(d);}catch{return;}for(const x of e){const p=path.join(d,x);if(!['/proc','/sys','/dev'].includes(p))walk(p);}};for(const d of dirs)walk(d);console.log(JSON.stringify(hits));`;
// Secrets go over stdin, never argv, and no error text is kept (it could echo input).
const scan=(c,dirs)=>{const r=spawnSync('docker',['--context',L.context,'exec','-i',c,'node','--input-type=module','-e',scanScript],{input:JSON.stringify({want:secrets,dirs}),encoding:'utf8',maxBuffer:1<<26});return r.status===0?JSON.parse(r.stdout.trim()):'scan failed with exit '+r.status;};
for(const t of ['a','b'])out.containerFiles[L.prefix+'-public-'+t]=scan(L.prefix+'-public-'+t,['/public-config.json','/public-server.mjs','/tmp','/root','/var/tmp','/etc','/home']);
// The Convex image has no node; grep the data volume through a throwaway busybox-free path: use the backend's own sh.
{const res={};for(const [k,v] of Object.entries(secrets)){const r=spawnSync('docker',['--context',L.context,'exec','-i',L.prefix+'-capture','sh','-c','grep -rlF -f /dev/stdin / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -20'],{input:v+'\n',encoding:'utf8'});const o=r.stdout.trim();if(o)res[k]=o.split('\n');}out.containerFiles[L.prefix+'-capture']=res;}
// Host: private state and the repository working trees (committed evidence included).
const walk=(d,acc)=>{for(const n of readdirSync(d)){if(['node_modules','.git'].includes(n))continue;const p=d+'/'+n;let s;try{s=statSync(p);}catch{continue;}if(s.isDirectory())walk(p,acc);else if(s.size<64*1024*1024){const hit=find(readFileSync(p,'latin1'));if(hit.length)acc[p.replace(L.directory,'')]=hit;}}return acc;};
out.hostFiles.marketingTree=walk(L.directory.replace(/\/$/,''),{});
out.hostFiles.gitTrackedHits=(()=>{const acc={};for(const [k,v] of Object.entries(secrets)){try{const r=execFileSync('git',['-C',L.directory,'grep','-lF',v],{encoding:'utf8'}).trim();if(r)acc[k]=r.split('\n');}catch{}}return acc;})();
out.hashesStored=Object.fromEntries(['edge-a','edge-b','reconciler-a','reconciler-b'].map(k=>[k,createHash('sha256').update(secrets[k]).digest('hex').slice(0,12)]));
L.save2('b4-keys',out);console.log(JSON.stringify(out,null,1));
