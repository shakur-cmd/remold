// Round-2 mutants, tenant A only. Each swaps one line, redeploys Convex when needed, runs the check that must catch
// it, then restores the original (and redeploys). Output: ownership/evidence/raw-capture/races/mutants-<label>.json
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {directory} from '../runtime.mjs';
const label=process.argv[2],out=directory+'ownership/evidence/raw-capture/races/mutants-'+label+'.json';
if(!/^[a-z0-9-]+$/.test(label??'')||existsSync(out))throw Error('usage: mutants.mjs <new-label>');
const convex=directory+'rawcapture/convex/capture.ts',rec=directory+'rawcapture/reconcile.mjs';
const mutants=[
 ['C4 settled capture can be re-settled',convex,"if(row!.status==='settled'){if(row!.outcome!==a.outcome||row!.contactId!==a.contactId)refuse('conflict');return 'duplicate';}",'','probe'],
 ['C5 store input validation removed',convex,"if(!TOKEN.test(a.idempotencyKey)||!validEmail(a.email)||a.firstname.length>NAME_MAX||/[\\x00-\\x1f\\x7f]/.test(a.firstname))refuse('invalid');",'','probe'],
 ['L1 acquire ignores a live lease',convex,"if(old&&old.token!==a.token&&old.expiresAt>Date.now())refuse('leased');",'','probe'],
 ['L2 settle not fenced by the lease',convex,"const t=await tenantFor(ctx,a.key,'reconciler');await live(ctx,t,a.lease);","const t=await tenantFor(ctx,a.key,'reconciler');",'probe'],
 ['R1 Mautic refusal throws instead of rejected',rec,"if(r.status===400||r.status===422){outcome='rejected';reason=refusal(r);}","if(false){}",'faults'],
 ['R2 LIKE search instead of exact lookup',rec,"const p=new URLSearchParams({limit:'100','where[0][col]':'l.email','where[0][expr]':'eq','where[0][val]':email}),r=api(tenant,'/contacts?'+p);","const r=api(tenant,'/contacts?limit=100&search='+encodeURIComponent(email));if(Number(r.data?.total)>=100)throw Error('Do not truncate the email match set');",'poison'],
 ['R3 a 200 upsert is treated as our new contact and named',rec,"else if(r.status===201&&!seen.includes(r.data.contact.id)){","else if(r.status===201||r.status===200){",'window'],
 ['M5 any non-2xx create settles as rejected',rec,"if(r.status===400||r.status===422){","if(r.status>=300){",'faults'],
 ['M6 no renew right before create',rec,"await sleep(pauseBeforeCreate);}\n     await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});","await sleep(pauseBeforeCreate);}",'stall'],
 ['D1 byte comparison drops collation-equal matches',rec," return Object.values(r.data.contacts).map(c=>c.id);"," return Object.values(r.data.contacts).filter(c=>String(c.fields.all.email??'').toLowerCase()===email.toLowerCase()).map(c=>c.id);",'collation'],
 ['D2 refused name update stops the run',rec,"if(p.status!==200)reason=","if(p.status!==200)throw Error('Mautic name update failed '+p.status);if(false)reason=",'faults'],
 ['D3 store caps back to 254 email and 100 name',convex,"const validEmail=(e:string)=>e.length<=64&&EMAIL.test(e);\nconst NAME_MAX=64;","const validEmail=(e:string)=>e.length<=254&&EMAIL.test(e)&&e.indexOf('@')<=64;\nconst NAME_MAX=100;",'probe'],
];
const deploy=()=>{const r=spawnSync(process.execPath,[directory+'rawcapture/setup.mjs'],{encoding:'utf8'});if(r.status!==0)throw Error('deploy failed '+r.stderr.slice(0,300));};
for(const [name,file,from] of mutants)if(!readFileSync(file,'utf8').includes(from))throw Error('anchor missing: '+name);
const results=[];
const only=process.argv[3];
for(const [name,file,from,to,section] of mutants.filter(m=>!only||m[0].startsWith(only+' '))){
 const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error('anchor missing: '+name);
 writeFileSync(file,original.replace(from,to));
 try{
  if(file===convex)deploy();
  const r=spawnSync(process.execPath,[directory+'rawcapture/races.mjs',section,label+'-'+name.split(' ')[0].toLowerCase()],{encoding:'utf8'});
  results.push({mutant:name,check:section,exit:r.status,killed:r.status!==0,summary:r.stdout.trim().split('\n').slice(0,6)});
 }finally{writeFileSync(file,original);if(file===convex)deploy();}
 console.log(results.at(-1).killed?'killed ':'SURVIVED ',name);
}
writeFileSync(out,JSON.stringify({label,at:new Date().toISOString(),results},null,1)+'\n',{flag:'wx'});
process.exitCode=results.every(r=>r.killed)?0:1;
