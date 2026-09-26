// IV r3: persistent 5xx poison. No attacker-controlled 5xx was found (c7-5xx-probe). Creating a MySQL trigger to force
// one needs SUPER (refused for the tenant DB user), so a copy of the reconciler answers 500 for one email on every
// create (instrumentation of the Mautic reply only; all other logic unchanged). Does the capture behind it reconcile?
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import * as L from './lib3.mjs';
const bad='iv-5xx-'+L.run+'@example.invalid',good='iv-after-5xx-'+L.run+'@example.invalid',out={bad,good};
const dir=L.directory+'rawcapture/.iv-5xx/';mkdirSync(dir,{recursive:true});
const from="const r=api(tenant,'/contacts/new','POST',{email:c.email});";
let src=readFileSync(L.directory+'rawcapture/reconcile.mjs','utf8').replaceAll("'../tenants/api.mjs'","'../../tenants/api.mjs'").replaceAll("'./runtime.mjs'","'../runtime.mjs'");
if(!src.includes(from))throw Error('anchor');src=src.replace(from,"const r=c.email===process.env.IV_BAD?{status:500,data:null}:api(tenant,'/contacts/new','POST',{email:c.email});");
writeFileSync(dir+'reconcile.mjs',src);
out.posts=[...await L.postA([{email:bad,firstname:'Persistent 5xx'}]),...await L.postA([{email:good,firstname:'Behind the 5xx'}])];
out.runs=[];for(let i=0;i<3;i++){const r=await L.reconcile(dir+'reconcile.mjs',{IV_BAD:bad});const inv=await L.inventory('a');out.runs.push({exit:r.exit,err:r.err,bad:inv.find(c=>c.email===bad)?.status,good:inv.find(c=>c.email===good)?.status});}
out.goodContactsWhileBlocked=L.withEmail('a',good).length;
const r=await L.reconcile(),inv=await L.inventory('a');rmSync(dir,{recursive:true,force:true});
out.afterFix={exit:r.exit,err:r.err,bad:inv.find(c=>c.email===bad)?.outcome,good:inv.find(c=>c.email===good)?.outcome,goodContacts:L.withEmail('a',good)};
out.verdict={haltsEveryRun:out.runs.every(x=>x.exit!==0&&x.good==='pending'),recoversWhenFixed:out.afterFix.exit===0&&out.afterFix.good==='created'};
L.save3('c8-5xx-poison'+(process.env.IV_LABEL?'-'+process.env.IV_LABEL:''),out);console.log(JSON.stringify(out));
