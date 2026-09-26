// IV mutants. Each mutant is applied to a temp copy of proofs/marketing (code only, no private state). The unit
// tests run against it; admission mutants are also run live against the refused forms from iv-after; selected
// server mutants are run live through an in-process edge on tenant A (same image/network as the deployed edge).
import {cpSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import * as L from './lib.mjs';
const src=L.directory,results=[];
const mutants=[
 ['M0 unmutated control','publishing/admission.mjs','export function','export function'],
 ['AM1 mapped-field check removed','publishing/admission.mjs',"for(const f of inputs)if(",'for(const f of [])if('],
 ['AM2 action check removed','publishing/admission.mjs',"if(Object.values(form.actions??{}).length)","if(false)"],
 ['AM3 campaign check removed','publishing/admission.mjs',"if(!Number.isSafeInteger(campaignLinks)||campaignLinks!==0)","if(false)"],
 ['AM4 published check removed','publishing/admission.mjs',"if(form.isPublished!==true)","if(false)"],
 ['AM5 standalone check removed','publishing/admission.mjs',"if(form.formType!=='standalone')","if(false)"],
 ['AM6 exact shape check removed','publishing/admission.mjs',"if(JSON.stringify(inputs.map","if(false&&JSON.stringify(inputs.map"],
 ['AM7 only mappedField checked','publishing/admission.mjs',"['mappedObject','mappedField','leadField']","['mappedField']"],
 ['AM8 campaign links >1 only','publishing/admission.mjs',"campaignLinks!==0","campaignLinks>1"],
 ['SM1 tracking cookie removed','publishing/server.mjs',"{Cookie:'Blocked-Tracking=1',DNT:'1','Sec-GPC':'1'}","{DNT:'1','Sec-GPC':'1'}"],
 ['SM2 tracking cookie value 0','publishing/server.mjs',"Cookie:'Blocked-Tracking=1'","Cookie:'Blocked-Tracking=0'"],
 ['SM3 privacy on GET only','publishing/server.mjs',"headers:method==='POST'?{...NATIVE_PRIVACY,","headers:method==='POST'?{"],
 ['SM4 start policy check removed','publishing/server.mjs',"if(config.admission?.policy!==TRACKING_POLICY||config.admission.formId!==config.form.id)","if(false)"],
 ['SM5 policy check ignores formId','publishing/server.mjs',"||config.admission.formId!==config.form.id)",")"],
 ['SM6 serialization removed','publishing/server.mjs',"const run=queue.then(()=>native(","const run=Promise.resolve().then(()=>native("],
 ['SM7 queue poisoned by a failure','publishing/server.mjs',"queue=run.catch(()=>{});","queue=run;"],
];
const liveForms={a:[1,...JSON.parse(readFileSync(L.directory+'ownership/evidence/admission/iv/iv-after.json')).refusals.filter(r=>r.tenant==='a'&&r.formId&&r.formId!==1).map(r=>r.formId)]};
for(const [name,file,from,to] of mutants){
 const dir=mkdtempSync(tmpdir()+'/iv-mut-');
 try{
  cpSync(src,dir,{recursive:true,filter:p=>!/\/(private|node_modules|evidence)(\/|$)/.test(p.slice(src.length-1))});
  const code=readFileSync(dir+'/'+file,'utf8');if(!code.includes(from))throw Error('mutation anchor missing: '+name);writeFileSync(dir+'/'+file,code.replace(from,to));
  const unit=spawnSync('node',['--test','publishing/server.test.mjs','publishing/admission.test.mjs'],{cwd:dir,encoding:'utf8'});
  const fail=Number(/ℹ fail (\d+)/.exec(unit.stdout)?.[1]??-1),failed=[...unit.stdout.matchAll(/^✖ (.+?) \(/gm)].map(m=>m[1]);
  const row={mutant:name,unitFail:fail,unitFailedTests:[...new Set(failed)]};
  if(file.endsWith('admission.mjs')){
   const {admitForm}=await import(dir+'/publishing/admission.mjs');
   row.liveAdmitted=liveForms.a.filter(id=>{try{admitForm('a',id);return true;}catch{return false;}});
  }
  if(['SM1','SM2','SM3','SM6'].includes(name.slice(0,3))){
   const formId=L.deployedFormId('a'),{admitForm}=await import('../../../../publishing/admission.mjs'),{form,admission}=admitForm('a',formId);
   const owner=L.makeOwner('a','mut-'+name.slice(0,3)),p0=L.profile('a',owner.id),c0=L.counts('a'),maxSub=Number(L.sql('a','SELECT COALESCE(MAX(id),0) FROM form_submissions'));
   const n=name.startsWith('SM6')?16:4,rows=Array.from({length:n},(_,i)=>({email:i%2?'iv-new-'+L.run+'-'+name.slice(0,3)+'@example.invalid':owner.email,firstname:'Mutant '+name.slice(0,3)+' '+i}));
   const res=L.probeEdge('a',{serverSource:readFileSync(dir+'/publishing/server.mjs','utf8'),form:L.edgeFormConfig(form),admission,rows,clientCookie:'Blocked-Tracking=0'});
   const p1=L.profile('a',owner.id),c1=L.counts('a'),subs=L.sql('a',`SELECT COALESCE(lead_id,'null') FROM form_submissions WHERE id>${maxSub}`).split('\n').filter(Boolean);
   row.live={statuses:res.map(r=>r.status),submissionLeads:subs,anonymous:[c0.anonymousContacts,c1.anonymousContacts],contacts:[c0.contacts,c1.contacts],ownerUnchanged:JSON.stringify(p0)===JSON.stringify(p1)};
  }
  results.push(row);console.log(JSON.stringify(row));
 }finally{rmSync(dir,{recursive:true,force:true});}
}
L.save('a7-mutants',{results});
