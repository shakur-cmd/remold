// IV r2 mutants of the edge guards. Each mutant runs the unit tests in a temp copy, then live: an in-process copy
// of the mutated server inside tenant A's edge container, using the deployed /public-config.json (real capture key).
import {cpSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import * as L from './lib2.mjs';
const src=L.directory+'publishing/server.mjs',orig=readFileSync(src,'utf8');
const mutants=[
 ['E0 unmutated control',null,null],
 ['E1 idempotency key random per post',"stored=await capture(values.get('n'),email,firstname)","stored=await capture(randomBytes(16).toString('hex'),email,firstname)"],
 ['E2 conflict answered 200',"return stored==='stored'?reply(res,200,'Submission received'):reply(res,409,'Submission conflicts with an earlier one');","return reply(res,200,'Submission received');"],
 ['E3 any capture reply counts as stored',"if(r.status==='success'&&typeof r.value?.id==='string')resolve('stored');","if(true)resolve('stored');"],
 ['E4 form token check removed',"if(!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(token,'hex')))return reply(res,403,'Wrong published form');",""],
 ['E5 nonce format check removed',"||!/^[a-f0-9]{32}$/.test(values.get('n')??'')",""],
 ['E6 origin check removed',"if(req.headers.origin&&req.headers.origin!=='http://'+config.host)return reply(res,403,'Wrong form origin');",""],
 ['E7 host check removed',"if(hosts.length!==1||req.headers.host!==config.host)return reply(res,421,'Unknown site');",""],
];
// Live probe: runs a sequence of posts against the mutated in-process edge. wrongKey swaps in an unregistered capture key.
const live=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');const fs=await import('node:fs');const crypto=await import('node:crypto');
const mod=await import('data:text/javascript;base64,'+Buffer.from(a.src).toString('base64'));const config=JSON.parse(fs.readFileSync('/public-config.json'));
const edge=mod.createPublicServer(a.wrongKey?{...config,capture:{...config.capture,key:'e'.repeat(64)}}:config);await new Promise(r=>edge.listen(0,'127.0.0.1',r));const token=mod.formToken(config);
const call=(b,h={})=>new Promise(resolve=>{const req=http.request({hostname:'127.0.0.1',port:edge.address().port,path:'/form/intake',method:'POST',headers:{Host:h.host??config.host,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b),...(h.origin?{Origin:h.origin}:{})}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(res.statusCode));});req.on('error',()=>resolve(0));req.end(b);});
const out=[];for(const p of a.posts){const q=new URLSearchParams({email:p.email,firstname:p.firstname,...(p.t===false?{}:{t:p.t??token}),...(p.n===false?{}:{n:p.n})}).toString();out.push(await call(q,p.h??{}));}edge.close();console.log(JSON.stringify(out));`;
const results=[];
for(const [name,from,to] of mutants){
 const dir=mkdtempSync(tmpdir()+'/iv-r2-mut-');
 try{
  cpSync(L.directory+'publishing',dir+'/publishing',{recursive:true,filter:p=>!p.includes('/evidence')});
  let code=orig;if(from){if(!code.includes(from))throw Error('anchor missing '+name);code=code.replace(from,to);}writeFileSync(dir+'/publishing/server.mjs',code);
  const unit=spawnSync('node',['--test','publishing/server.test.mjs'],{cwd:dir,encoding:'utf8'});
  const fail=Number(/ℹ fail (\d+)/.exec(unit.stdout)?.[1]??-1);
  const e='iv-r2mut-'+L.run+'-'+name.slice(0,2)+'@example.invalid',n1=L.nonce(),n2=L.nonce();
  const inv0=(await L.inventory('a')).map(c=>c.id);
  const posts=[{email:e,firstname:'Same',n:n1},{email:e,firstname:'Same',n:n1},{email:e,firstname:'Changed',n:n1},{email:e,firstname:'NoToken',n:L.nonce(),t:false},{email:e,firstname:'OtherToken',n:L.nonce(),t:L.token('b')},{email:e,firstname:'NoNonce',n:false},{email:e,firstname:'Origin',n:L.nonce(),h:{origin:'http://evil.invalid'}},{email:e,firstname:'Host',n:L.nonce(),h:{host:'tenant-b.marketing-proof.invalid'}}];
  const statuses=L.inContainer(L.prefix+'-public-a',live,{src:code,posts});
  const wrongKey=L.inContainer(L.prefix+'-public-a',live,{src:code,wrongKey:true,posts:[{email:e,firstname:'WrongKey',n:n2}]});
  const added=(await L.inventory('a')).filter(c=>!inv0.includes(c.id));
  const row={mutant:name,unitFail:fail,unitFailed:[...new Set([...unit.stdout.matchAll(/^✖ (.+?) \(/gm)].map(m=>m[1]))],live:{statuses,wrongKeyStatus:wrongKey[0],addedCaptures:added.map(c=>c.firstname)}};
  row.liveHarm=[statuses[1]===200&&added.filter(c=>c.firstname==='Same').length>1&&'retry duplicated',statuses[2]===200&&'changed values acknowledged',statuses[3]===200&&'no token accepted',statuses[4]===200&&'other tenant token accepted',statuses[5]===200&&'missing nonce accepted',statuses[6]===200&&'foreign origin accepted',statuses[7]===200&&'foreign host accepted',wrongKey[0]===200&&'acknowledged without storing'].filter(Boolean);
  results.push(row);console.log(JSON.stringify(row));
 }finally{rmSync(dir,{recursive:true,force:true});}
}
L.save2('b7-edge-mutants',{results});
