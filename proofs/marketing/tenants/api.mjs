import {execFileSync} from 'node:child_process';
import {context,prefix} from '../runtime.mjs';
// Test-driver access stays inside the selected container; no new host tunnel or public admin endpoint.
export function api(tenant,path,method='GET',body,password){
 if(!['a','b'].includes(tenant)||!path.startsWith('/'))throw Error('Unknown fixture endpoint');
 const script=`let raw='';for await(const chunk of process.stdin)raw+=chunk;const a=JSON.parse(raw);const r=await fetch('http://127.0.0.1/api'+a.path,{method:a.method,redirect:'manual',headers:{Authorization:'Basic '+Buffer.from('proof:'+(Object.hasOwn(a,'password')?a.password:process.env.REMOLD_ADMIN_PASSWORD)).toString('base64'),'Content-Type':'application/json'},...(a.body?{body:JSON.stringify(a.body)}:{}),signal:AbortSignal.timeout(10000)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=null;}console.log(JSON.stringify({status:r.status,data}));`;
 try{return JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-web-'+tenant,'node','--input-type=module','-e',script],{input:JSON.stringify({path,method,body,...(password===undefined?{}:{password})}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));}
 catch{throw Error('Local '+tenant+' API call failed; no credentials printed');}
}
