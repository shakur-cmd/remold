// IV r2 mutants of the Convex raw-capture guards. Each mutant is deployed to the live capture backend from a temp
// copy, probed, and the original is redeployed at the end (and verified). Admin key is read from private state and
// never printed.
import {cpSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as L from './lib2.mjs';
const st=JSON.parse(readFileSync(L.directory+'private/rawcapture/state.json')),cli='/Users/urkel/Documents/CodeMyVibe/Projects/remold/node_modules/convex/bin/main.js';
const work=L.directory+'rawcapture-ivmut/';
const deploy=code=>{rmSync(work,{recursive:true,force:true});cpSync(L.directory+'rawcapture',work,{recursive:true});symlinkSync('/Users/urkel/Documents/CodeMyVibe/Projects/remold/node_modules',work+'node_modules');
 writeFileSync(work+'convex/capture.ts',code);
 try{execFileSync(process.execPath,[cli,'dev','--once','--typecheck','disable'],{cwd:work,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_DISABLE_METRICS:'1',CONVEX_SELF_HOSTED_URL:'http://127.0.0.1:3547',CONVEX_SELF_HOSTED_ADMIN_KEY:st.adminKey},stdio:['ignore','pipe','pipe']});return 'deployed';}
 catch(e){return 'deploy failed exit '+e.status;}finally{rmSync(work,{recursive:true,force:true});}};
const orig=readFileSync(L.directory+'rawcapture/convex/capture.ts','utf8');
const code=async fn=>{try{return {ok:await fn()};}catch(e){return {refused:e.code??String(e.message).slice(0,80)};}};
const edgePost=(t,rows)=>L.rawRequests(t,rows.map(r=>L.P(t,L.body(t,r.email,r.firstname,r.n)))).map(x=>x.statuses[0]);
// One probe set, run against every deployment (control, mutants, restored).
async function probes(){
 const n=L.nonce(),e='iv-r2cvx-'+L.run+'-'+n.slice(0,6)+'@example.invalid';
 const conflict=edgePost('a',[{email:e,firstname:'First',n},{email:e,firstname:'Changed',n}]);
 const edgeReadsPending=await code(async()=>(await L.query('capture:pending',{key:L.K.a.edge,limit:1})).length);
 const bn=L.nonce();edgePost('b',[{email:'iv-r2cvx-b-'+L.run+'-'+bn.slice(0,6)+'@example.invalid',firstname:'B probe',n:bn}]);const bRow=(await L.inventory('b')).find(c=>c.idempotencyKey===bn);
 const aSettlesB=await code(()=>L.mutation('capture:settle',{key:L.K.a.reconciler,id:bRow.id,outcome:'existing',contactId:999999}));
 const aRow=(await L.inventory('a')).find(c=>c.idempotencyKey===n);
 await L.mutation('capture:settle',{key:L.K.a.reconciler,id:aRow.id,outcome:'existing',contactId:1});
 const resettle=await code(()=>L.mutation('capture:settle',{key:L.K.a.reconciler,id:aRow.id,outcome:'existing',contactId:2}));
 const afterResettle=(await L.inventory('a')).find(c=>c.id===aRow.id).contactId;
 const junk=await code(()=>L.mutation('capture:capture',{key:L.K.a.edge,idempotencyKey:'not-a-nonce',email:'not an email',firstname:'x\n'}));
 return {conflict,edgeReadsPending,aSettlesB:{...aSettlesB,bCapture:bRow.id},resettle,afterResettleContactId:afterResettle,junkDirect:junk};
}
const mutants=[
 ['C0 deployed original (control)',null,null],
 ['C1 role check removed',"if(!row||row.role!==want)refuse('credential');","if(!row)refuse('credential');"],
 ['C2 payload conflict removed',"if(old){if(old.payloadSha256!==payloadSha256)refuse('conflict');return {id:old._id,duplicate:true};}","if(old){return {id:old._id,duplicate:true};}"],
 ['C3 settle tenant scope removed',"if(!row||row.tenant!==t)refuse('scope');","if(!row)refuse('scope');"],
 ['C4 settled rows can be re-settled',"if(row!.status==='settled'){if(row!.outcome!==a.outcome||row!.contactId!==a.contactId)refuse('conflict');return 'duplicate';}",""],
 ['C5 capture input validation removed',"if(!/^[a-f0-9]{32}$/.test(a.idempotencyKey)||a.email.length>254||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(a.email)||a.firstname.length>100||/[\\x00-\\x1f\\x7f]/.test(a.firstname))refuse('invalid');",""],
];
const results=[];
try{
 for(const [name,from,to] of mutants){
  let src=orig;if(from){if(!src.includes(from))throw Error('anchor missing '+name);src=src.replace(from,to);}
  const dep=from?deploy(src):'already deployed';const p=await probes();
  const harm=[p.conflict[1]===200&&'changed values acknowledged',p.edgeReadsPending.ok!==undefined&&'edge key reads pending captures',p.aSettlesB.ok!==undefined&&'tenant A settled a tenant B capture',p.afterResettleContactId===2&&'settled capture rewritten',p.junkDirect.ok!==undefined&&'invalid capture stored'].filter(Boolean);
  results.push({mutant:name,deploy:dep,probes:p,harm});console.log(JSON.stringify({name,dep,harm,p}));
 }
}finally{
 const dep=deploy(orig);const p=await probes();
 const restored={deploy:dep,probes:p,ok:p.conflict[1]===409&&p.edgeReadsPending.refused&&p.aSettlesB.refused&&p.resettle.refused&&p.afterResettleContactId===1&&p.junkDirect.refused};
 results.push({mutant:'restored original',...restored});console.log('RESTORED',JSON.stringify(restored));
 L.save2('b9-convex-mutants',{results});
}
