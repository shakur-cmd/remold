import {readFileSync} from 'node:fs';
import {directory} from './runtime.mjs';
export async function mautic(path,method='GET',body){
 const {adminPassword}=JSON.parse(readFileSync(directory+'private/runtime.json','utf8'));
 const response=await fetch('http://127.0.0.1:3540/api'+path,{method,headers:{Authorization:'Basic '+Buffer.from('proof:'+adminPassword).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();
 if(!response.ok)throw Error('Mautic API '+method+' '+path+' status '+response.status+' '+JSON.stringify(value.errors));
 return value;
}
