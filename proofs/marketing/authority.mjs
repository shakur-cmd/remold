import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {directory} from './runtime.mjs';
export function authorityEnvironment(){
 const local=Object.fromEntries(readFileSync(directory+'.env.local','utf8').split('\n').filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
 return {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_DISABLE_METRICS:'1',CONVEX_SELF_HOSTED_URL:local.CONVEX_SELF_HOSTED_URL,CONVEX_SELF_HOSTED_ADMIN_KEY:local.CONVEX_SELF_HOSTED_ADMIN_KEY};
}
export function authority(path,args){
 const env=authorityEnvironment();
 try{const result=execFileSync(process.execPath,[directory+'../../node_modules/convex/bin/main.js','run',path,JSON.stringify(args)],{cwd:directory,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});return result.trim()?JSON.parse(result):null;}
 catch{throw Error('Isolated authority refused '+path);}
}
