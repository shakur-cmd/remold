// IV round 3 helpers (d81feef). Re-exports round-2 helpers; evidence is written beside this file.
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import * as L from '../r2/lib2.mjs';
export * from '../r2/lib2.mjs';
export const save3=(name,data)=>writeFileSync(new URL('./'+name+'.json',import.meta.url),JSON.stringify({run:L.run,capturedAt:new Date().toISOString(),...data},null,1)+'\n',{flag:'wx'});
// Run a reconciler file (original or an instrumented/mutated copy) for tenant A; stderr lines are streamed to onErr.
export const reconcile=(file=L.directory+'rawcapture/reconcile.mjs',env={},onErr=()=>{})=>new Promise(r=>{const p=spawn(process.execPath,[file,'a'],{env:{...process.env,...env}});let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>{e+=d;onErr(String(d),e);});p.on('close',c=>{let log=null;try{log=JSON.parse(o.trim());}catch{}r({exit:c,log,err:(e.match(/Raw capture capture:\w+ refused: \w+|Error: [^\n]*|AssertionError[^\n]*/)?.[0]??'').slice(0,200)});});});
export const postA=async rows=>(await L.burst(L.prefix+'-public-a',{hostname:'127.0.0.1',port:8080,host:L.host('a'),bodies:rows.map(r=>L.body('a',r.email,r.firstname,r.n??L.nonce()))})).map(r=>r.status);
export const pendingA=async()=>(await L.inventory('a')).filter(c=>c.status==='pending');
