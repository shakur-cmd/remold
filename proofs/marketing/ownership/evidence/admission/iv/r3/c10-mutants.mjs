// IV r3 mutants beyond the builder's seven. Same method as rawcapture/mutants.mjs: swap one line in place, redeploy
// Convex when needed, run the checks that should catch it, restore and redeploy in finally.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import * as L from './lib3.mjs';
const D=L.directory,convex=D+'rawcapture/convex/capture.ts',rec=D+'rawcapture/reconcile.mjs',edge=D+'publishing/server.mjs';
const deploy=()=>{const r=spawnSync(process.execPath,[D+'rawcapture/setup.mjs'],{encoding:'utf8'});if(r.status!==0)throw Error('deploy failed');};
const node=(args,env={})=>{const r=spawnSync(process.execPath,args,{encoding:'utf8',cwd:D,env:{...process.env,...env}});return {exit:r.status,out:r.stdout.trim().split('\n').slice(-3).join(' | ').slice(0,300)};};
const OLD="/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/";
const mutants=[
 ['M1 edge email rule back to the loose r2 rule',edge,"export const validEmail=email=>email.length<=254&&EMAIL.test(email)&&email.indexOf('@')<=64;","export const validEmail=email=>email.length<=254&&"+OLD+".test(email);",['unit']],
 ['M2 store email rule back to the loose r2 rule',convex,"const validEmail=(e:string)=>e.length<=254&&EMAIL.test(e)&&e.indexOf('@')<=64;","const validEmail=(e:string)=>e.length<=254&&"+OLD+".test(e);",['probe']],
 ['M3 lease expiry not checked on renew/settle',convex,"if(!l||l.token!==token||l.expiresAt<=Date.now())refuse('stale');","if(!l||l.token!==token)refuse('stale');",['probe']],
 ['M4 acquire refuses an expired lease held by another',convex,"if(old&&old.token!==a.token&&old.expiresAt>Date.now())refuse('leased');","if(old&&old.token!==a.token)refuse('leased');",['probe']],
 ['M5 any non-2xx create settles as rejected',rec,"if(r.status===400||r.status===422){outcome='rejected';reason=refusal(r);}","if(r.status>=300){outcome='rejected';reason=refusal(r);}",['poison','c8']],
 ['M6 no renew right before create',rec,"     await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});\n     const r=api(tenant,'/contacts/new'","     const r=api(tenant,'/contacts/new'",['window','poison']],
 ['M7 exact lookup trusts the LIKE-free DB rows but drops the JS equality filter',rec,".filter(c=>String(c.fields.all.email??'').toLowerCase()===email.toLowerCase())","",['poison','c6']],
];
const results=[];let label=0;
for(const [name,file,from,to,checks] of mutants.filter(m=>!process.env.IV_ONLY||process.env.IV_ONLY.split(',').includes(m[0].split(' ')[0]))){
 if(process.env.IV_CHECKS)checks.splice(0,checks.length,...JSON.parse(process.env.IV_CHECKS)[name.split(' ')[0]]);
 const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error('anchor missing: '+name);
 writeFileSync(file,original.replace(from,to));const row={mutant:name,checks:{}};
 try{
  if(file===convex)deploy();
  for(const c of checks){
   const tag='iv-'+(process.env.IV_LABEL??'r3')+'m-'+L.run.slice(0,6)+'-'+(++label);
   if(c==='unit')row.checks.unit=node(['--test','publishing/server.test.mjs']);
   else if(c==='c8')row.checks.c8=node([D+'ownership/evidence/admission/iv/r3/c8-5xx-poison.mjs'],{IV_LABEL:'m'+label});
   else if(c==='c6')row.checks.c6=node([D+'ownership/evidence/admission/iv/r3/c6-collation.mjs'],{IV_LABEL:'m'+label});
   else row.checks[c]=node([D+'rawcapture/races.mjs',c,tag]);
  }
 }finally{writeFileSync(file,original);if(file===convex)deploy();}
 row.killedByBuilderSuite=Object.entries(row.checks).some(([k,v])=>['unit','probe','window','poison','faults','stall','collation'].includes(k)&&v.exit!==0);
 results.push(row);console.log(JSON.stringify(row));
}
L.save3('c10-mutants'+(process.env.IV_LABEL?'-'+process.env.IV_LABEL:''),{results});
