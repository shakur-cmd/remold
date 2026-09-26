// Idempotent: create the raw-capture backend, open the loopback forward, deploy functions, register per-tenant keys.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {docker,directory,prefix,images} from '../runtime.mjs';
import {name,port,url,privateDir} from './runtime.mjs';
mkdirSync(privateDir,{recursive:true,mode:0o700});
const statePath=privateDir+'state.json',state=existsSync(statePath)?JSON.parse(readFileSync(statePath)):{instanceSecret:randomBytes(32).toString('hex')};
writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
let current;try{current=JSON.parse(docker(['inspect',name]))[0];}catch{}
if(!current){
 const envPath=privateDir+'convex.env';
 writeFileSync(envPath,Object.entries({INSTANCE_NAME:'remold-raw-capture',INSTANCE_SECRET:state.instanceSecret,CONVEX_CLOUD_ORIGIN:url,CONVEX_SITE_ORIGIN:'http://127.0.0.1:3548',DISABLE_BEACON:'true',DISABLE_METRICS_ENDPOINT:'true'}).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
 docker(['volume','create','--label','remold.proof=marketing',prefix+'-rawcapture']);
 docker(['run','-d','--name',name,'--label','remold.proof=marketing','--network',prefix,'--network-alias','capture','--memory','512m','--sysctl','net.ipv4.ip_forward=0','--env-file',envPath,'--mount','type=volume,src='+prefix+'-rawcapture,dst=/convex/data',images.convex]);
 docker(['network','connect','--alias','capture',prefix+'-tenant-b',name]);
 current=JSON.parse(docker(['inspect',name]))[0];
}
assert.equal(current.Config.Labels['remold.proof'],'marketing');assert.deepEqual(Object.keys(current.NetworkSettings.Networks).sort(),[prefix,prefix+'-tenant-b']);
assert.equal(Object.keys(current.HostConfig.PortBindings??{}).length,0);
for(const n of [prefix,prefix+'-tenant-b'])assert.equal(JSON.parse(docker(['network','inspect',n]))[0].Internal,true);
// The backend sits on both tenant networks; it must not route packets between them.
assert.equal(docker(['exec',name,'cat','/proc/sys/net/ipv4/ip_forward']).trim(),'0');
const ip=current.NetworkSettings.Networks[prefix].IPAddress;
async function up(){try{return (await fetch(url+'/version',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}}
if(!await up()){
 const ssh=spawn('ssh',['-F',process.env.HOME+'/.colima/_lima/colima-remold-proof/ssh.config','-N','-o','ControlMaster=no','-o','ControlPath=none','-o','ExitOnForwardFailure=yes','-L','127.0.0.1:'+port+':'+ip+':3210','lima-colima-remold-proof'],{detached:true,stdio:'ignore'});ssh.unref();
 writeFileSync(privateDir+'forward.pid',String(ssh.pid),{mode:0o600});
 const deadline=Date.now()+60000;while(!await up()){assert.ok(Date.now()<deadline,'Raw capture backend not reachable');await new Promise(r=>setTimeout(r,500));}
}
if(!state.adminKey){state.adminKey=docker(['exec',name,'./generate_admin_key.sh']).trim();assert.ok(state.adminKey&&!state.adminKey.includes('\n'));writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
const cli=directory+'../../node_modules/convex/bin/main.js',root=directory+'rawcapture/';
const bin=(existsSync(cli)?directory+'../../':directory+'../../../../../')+'node_modules/.bin';
const env={PATH:bin+':'+process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_DISABLE_METRICS:'1',CONVEX_SELF_HOSTED_URL:url,CONVEX_SELF_HOSTED_ADMIN_KEY:state.adminKey};
const run=args=>execFileSync(process.execPath,[existsSync(cli)?cli:directory+'../../../../../node_modules/convex/bin/main.js',...args],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
writeFileSync(privateDir+'deploy.log',run(['dev','--once','--typecheck','disable']),{mode:0o600});
const keysPath=privateDir+'keys.json',keys=existsSync(keysPath)?JSON.parse(readFileSync(keysPath)):Object.fromEntries(['a','b'].map(t=>[t,{edge:randomBytes(32).toString('hex'),reconciler:randomBytes(32).toString('hex')}]));
writeFileSync(keysPath,JSON.stringify(keys),{mode:0o600});
for(const t of ['a','b'])for(const role of ['edge','reconciler'])run(['run','capture:registerKey',JSON.stringify({keyHash:createHash('sha256').update(keys[t][role]).digest('hex'),tenant:t,role})]);
console.log('Raw capture backend ready on both internal tenant networks; functions deployed; four keys registered.');
