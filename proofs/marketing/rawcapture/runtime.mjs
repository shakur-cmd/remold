// Isolated raw-capture Convex backend: its own container on both internal tenant networks, reached from the host only
// through a loopback SSH forward on 127.0.0.1:3547. No Docker port binding, DNS, TLS or public port.
import {readFileSync,existsSync} from 'node:fs';
import {directory,prefix} from '../runtime.mjs';
export const name=prefix+'-capture',port=3547,url='http://127.0.0.1:'+port,privateDir=directory+'private/rawcapture/';
export const keys=()=>JSON.parse(readFileSync(privateDir+'keys.json','utf8'));
export const ready=()=>existsSync(privateDir+'keys.json');
async function call(kind,path,args){
 const r=await fetch(url+'/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,args,format:'json'}),signal:AbortSignal.timeout(15000)});
 const body=await r.json();if(body.status!=='success'){const e=Error('Raw capture '+path+' refused: '+(body.errorData?.code??body.errorMessage));e.code=body.errorData?.code;throw e;}
 return body.value;
}
export const query=(path,args)=>call('query',path,args),mutation=(path,args)=>call('mutation',path,args);
