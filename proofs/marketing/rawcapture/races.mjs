// Reconciler and store checks on tenant A only (db-b sits near its memory limit). One-shot per label.
//   window: an admin creates the same email, with DNC, while the reconciler pauses between lookup and create.
//   poison: captures Mautic refuses or that a LIKE search over-matches must not stop the captures behind them.
//   probe:  Convex-only refusals (input validation, re-settle, lease fencing); no Mautic call at all.
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {directory,prefix,docker} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {keys,query,mutation} from './runtime.mjs';
export const K=keys(),hex=n=>randomBytes(n).toString('hex');
const sql=q=>docker(['exec',prefix+'-db-a','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
const withEmail=e=>sql(`SELECT id,COALESCE(firstname,'') FROM leads WHERE email='${e.replace(/[^A-Za-z0-9@._+-]/g,'')}' ORDER BY id`).split('\n').filter(Boolean).map(l=>{const [id,firstname]=l.split('\t');return {id:Number(id),firstname};});
const ok=r=>{if(r.status<200||r.status>=300)throw Error('Mautic API refused '+r.status);return r.data;};
const reconciler=(env={},onStderr=()=>{},file=directory+'rawcapture/reconcile.mjs')=>new Promise(r=>{const p=spawn(process.execPath,[file,'a'],{env:{...process.env,...env}});let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>{e+=d;onStderr(e);});p.on('close',c=>{let log=null;try{log=JSON.parse(o.trim());}catch{}r({exit:c,log,err:(e.match(/Raw capture capture:\w+ refused: \w+/)?.[0]??e.split('\n').find(l=>/Error/.test(l))??'').slice(0,200)});});});
const capture=(email,firstname)=>mutation('capture:capture',{key:K.a.edge,idempotencyKey:hex(16),email,firstname});
const inv=async()=>query('capture:inventory',{key:K.a.reconciler});
async function refused(fn){try{await fn();return null;}catch(e){return e.code??e.message;}}

export async function probe(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const before=(await inv()).length;
 const bad=['iv%pct@example.invalid','%@%.%','a*b@example.invalid','a b@example.invalid','a@b','a@@example.invalid','.a@example.invalid','a..b@example.invalid','a@-x.invalid','x@example.invalid\n',"o'neil@example.invalid",'a&b@example.invalid','x'.repeat(65)+'@example.invalid','a@'+'d'.repeat(250)+'.invalid','x'.repeat(49)+'@example.invalid'];
 for(const email of bad){const code=await refused(()=>capture(email,'Probe'));check(code==='invalid','store refuses email '+JSON.stringify(email),code);}
 for(const [label,args] of [['control char in first name',{email:'ok@example.invalid',firstname:'a\u0007b'}],['65-char first name',{email:'ok@example.invalid',firstname:'x'.repeat(65)}],['short nonce',{email:'ok@example.invalid',firstname:'',idempotencyKey:'abc'}]]){const code=await refused(()=>mutation('capture:capture',{key:K.a.edge,idempotencyKey:hex(16),...args}));check(code==='invalid','store refuses '+label,code);}
 check((await inv()).length===before,'no refused input was stored',[before,(await inv()).length]);
 // Lease: one holder per tenant; a stale or foreign token cannot settle or renew.
 const t1=hex(16),t2=hex(16);
 check(await refused(()=>mutation('capture:acquire',{key:K.a.reconciler,token:t1,ttlMs:20000}))===null,'first reconciler acquires the lease');
 check(await refused(()=>mutation('capture:acquire',{key:K.a.reconciler,token:t2,ttlMs:20000}))==='leased','second reconciler is refused while the lease is live');
 check(await refused(()=>mutation('capture:acquire',{key:K.b.reconciler,token:t2,ttlMs:20000}))===null,'tenant B lease is independent of A');
 await refused(()=>mutation('capture:release',{key:K.b.reconciler,token:t2}));
 check(await refused(()=>mutation('capture:renew',{key:K.a.reconciler,token:t2,ttlMs:20000}))==='stale','a foreign token cannot renew');
 const settled=(await inv()).find(c=>c.status==='settled'&&c.outcome==='existing');
 check(settled&&await refused(()=>mutation('capture:settle',{key:K.a.reconciler,lease:t1,id:settled.id,outcome:'created',contactId:settled.contactId}))==='conflict','a settled capture cannot be re-settled differently, even by the lease holder',settled?.id);
 check(settled&&await refused(()=>mutation('capture:settle',{key:K.a.reconciler,lease:t2,id:settled.id,outcome:'existing',contactId:settled.contactId}))==='stale','settle with a stale lease token is refused');
 await refused(()=>mutation('capture:release',{key:K.a.reconciler,token:t1}));
 check(await refused(()=>mutation('capture:acquire',{key:K.a.reconciler,token:t2,ttlMs:1}))===null,'after release the lease can be taken');
 await new Promise(r=>setTimeout(r,50));
 check(settled&&await refused(()=>mutation('capture:settle',{key:K.a.reconciler,lease:t2,id:settled.id,outcome:'existing',contactId:settled.contactId}))==='stale','settle with an expired lease is refused');
 check(await refused(()=>mutation('capture:acquire',{key:K.a.reconciler,token:t1,ttlMs:20000}))===null,'an expired lease can be taken over');
 await refused(()=>mutation('capture:release',{key:K.a.reconciler,token:t1}));
 return checks;
}

async function windowRace(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const email='win-'+randomUUID().slice(0,8)+'@example.invalid';await capture(email,'Public suggestion');
 // The admin create happens only once the reconciler reports it has looked the email up and is about to create.
 let paused;const reached=new Promise(r=>{paused=r;}),rec=reconciler({REMOLD_RECONCILE_PAUSE_BEFORE_CREATE_MS:'5000'},e=>{if(e.includes('PAUSED '+email))paused(true);});
 const inWindow=await Promise.race([reached,rec.then(()=>false)]);check(inWindow,'admin create landed inside the lookup-then-create window');
 const admin=ok(api('a','/contacts/new','POST',{email,firstname:'Admin',lastname:'Owner'})).contact;ok(api('a','/contacts/'+admin.id+'/dnc/email/add','POST',{reason:3}));
 const r=await rec,after=ok(api('a','/contacts/'+admin.id)).contact,row=(await inv()).find(c=>c.email===email);
 const out={email,adminId:admin.id,reconciler:r,adminAfter:{firstname:after.fields.all.firstname,dnc:after.doNotContact.length},contacts:withEmail(email),capture:row&&{status:row.status,outcome:row.outcome,contactId:row.contactId}};
 check(r.exit===0,'reconciler completes',r.err);
 check(out.adminAfter.firstname==='Admin','admin contact first name not overwritten by the public suggestion',out.adminAfter.firstname);
 check(out.adminAfter.dnc===1,'admin DNC kept');
 check(out.contacts.length===1,'one contact for the email',out.contacts);
 check(row?.outcome==='existing'&&row.contactId===admin.id,'capture settled as existing on the admin contact',out.capture);
 return {checks,out};
}

async function poison(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const tag=randomUUID().slice(0,8),under='_'+tag+'@example.invalid',good='good-'+tag+'@example.invalid';
 // Valid syntax, but Mautic's LIKE search treats _ as a wildcard and would match hundreds of contacts.
 for(const [e,n] of [[under,'Underscore'],[good,'Good after poison']])await capture(e,n);
 const r=await reconciler(),rows=await inv(),row=e=>rows.find(c=>c.email===e);
 const out={reconciler:{exit:r.exit,err:r.err},underscore:row(under),good:row(good),contacts:{underscore:withEmail(under),good:withEmail(good)}};
 check(r.exit===0,'reconciler completes despite poison',r.err);
 check(row(under)?.status==='settled'&&out.contacts.underscore.length===1&&row(under).contactId===out.contacts.underscore[0].id,'underscore email resolved by exact match, one contact',row(under));
 check(row(good)?.outcome==='created'&&out.contacts.good.length===1&&out.contacts.good[0].firstname==='Good after poison','capture behind the poison is created with its suggested name',out.contacts.good);
 check(rows.filter(c=>c.status==='pending').length===0,'nothing left pending on A');
 return {checks,out};
}

// Mautic answers observed on this proof are imitated in an instrumented copy of the reconciler (reply substitution only):
// a 400 on create, a 400 on the name update, and a 500 on create for three specific emails.
function faulty(faults){
 const dir=directory+'rawcapture/.races-fault/';mkdirSync(dir,{recursive:true});
 let src=readFileSync(directory+'rawcapture/reconcile.mjs','utf8').replaceAll("'../tenants/api.mjs'","'../../tenants/api.mjs'").replaceAll("'./runtime.mjs'","'../runtime.mjs'");
 const create="const r=api(tenant,'/contacts/new','POST',{email:c.email});",name="const p=api(tenant,'/contacts/'+contactId+'/edit','PATCH',{firstname:c.firstname});";
 if(!src.includes(create)||!src.includes(name))throw Error('fault anchors missing');
 src=src.replace(create,`const r=c.email===${JSON.stringify(faults.create400)}?{status:400,data:{errors:[{message:'fault: refused'}]}}:c.email===${JSON.stringify(faults.create500)}?{status:500,data:null}:api(tenant,'/contacts/new','POST',{email:c.email});`)
  .replace(name,`const p=c.email===${JSON.stringify(faults.name400)}?{status:400,data:{errors:[{message:'fault: name refused'}]}}:api(tenant,'/contacts/'+contactId+'/edit','PATCH',{firstname:c.firstname});`);
 writeFileSync(dir+'reconcile.mjs',src);return {file:dir+'reconcile.mjs',done:()=>rmSync(dir,{recursive:true,force:true})};
}

async function faults(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const tag=randomUUID().slice(0,8),e400='f400-'+tag+'@example.invalid',en='fname-'+tag+'@example.invalid',good='fgood-'+tag+'@example.invalid',e500='f500-'+tag+'@example.invalid';
 for(const [e,n] of [[e400,'Refused'],[en,'Name refused'],[good,'Good'],[e500,'Outage']])await capture(e,n);
 const f=faulty({create400:e400,name400:en,create500:e500});let r;try{r=await reconciler({},()=>{},f.file);}finally{f.done();}
 const rows=await inv(),row=e=>rows.find(c=>c.email===e),out={faultyRun:{exit:r.exit,err:r.err},e400:row(e400),en:row(en),good:row(good),e500:row(e500),contacts:{e400:withEmail(e400),en:withEmail(en),good:withEmail(good),e500:withEmail(e500)}};
 check(row(e400)?.outcome==='rejected'&&/400/.test(row(e400).reason??''),'a create Mautic refuses (400) settles as rejected with the reason',row(e400));
 check(row(en)?.outcome==='created'&&/name/.test(row(en).reason??'')&&out.contacts.en.length===1&&(out.contacts.en[0].firstname??'')==='','a refused name update is recorded and the contact kept unnamed',row(en));
 check(row(good)?.outcome==='created'&&out.contacts.good[0]?.firstname==='Good','captures after both refusals are still created',out.contacts.good);
 check(r.exit!==0&&row(e500)?.status==='pending'&&out.contacts.e500.length===0,'a 500 on create stops the run and leaves the capture pending, never rejected',{exit:r.exit,row:row(e500)});
 const again=await reconciler();out.realRun={exit:again.exit,err:again.err,e500:(await inv()).find(c=>c.email===e500)};
 check(again.exit===0&&out.realRun.e500?.outcome==='created','once Mautic answers normally the pending capture is created',out.realRun);
 return {checks,out};
}

async function collation(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const tag=randomUUID().slice(0,8),stored='josé-'+tag+'@example.invalid',captured='jose-'+tag+'@example.invalid';
 // Mautic's API strips non-ASCII from emails, so an owner like this exists only via import or direct DB (as the IV did).
 const owner=ok(api('a','/contacts/new','POST',{email:'coll-'+tag+'@example.invalid',firstname:'Collation owner'})).contact;ok(api('a','/contacts/'+owner.id+'/dnc/email/add','POST',{reason:3}));
 const sqlU=q=>docker(['exec',prefix+'-db-a','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql --default-character-set=utf8mb4 -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
 sqlU(`UPDATE leads SET email='${stored}' WHERE id=${owner.id}`);const before=sqlU('SELECT HEX(email) FROM leads WHERE id='+owner.id);
 await capture(captured,'Public');const r=await reconciler(),row=(await inv()).find(c=>c.email===captured),after=sqlU('SELECT HEX(email) FROM leads WHERE id='+owner.id),dnc=ok(api('a','/contacts/'+owner.id)).contact.doNotContact.length;
 const out={ownerId:owner.id,reconciler:{exit:r.exit,err:r.err},capture:row&&{outcome:row.outcome,contactId:row.contactId},ownerEmailBytesUnchanged:before===after,dnc,plainContacts:sqlU(`SELECT COUNT(*) FROM leads WHERE email='${captured}' AND id<>${owner.id}`)};
 check(r.exit===0,'reconciler completes',r.err);
 check(before===after,'owner email bytes not rewritten by a collation-equal capture');
 check(dnc===1,'owner DNC kept');
 check(row?.outcome==='existing'&&row.contactId===owner.id&&out.plainContacts==='0','capture links to the collation-equal owner; no new contact',out);
 return {checks,out};
}

async function stall(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const email='stall-'+randomUUID().slice(0,8)+'@example.invalid';await capture(email,'Stalled');
 // Pause longer than the 15 s lease between lookup and create: the lease has lapsed, so nothing may be written.
 const r=await reconciler({REMOLD_RECONCILE_PAUSE_BEFORE_CREATE_MS:'17000'}),row=(await inv()).find(c=>c.email===email),during=withEmail(email);
 check(r.exit!==0&&/stale/.test(r.err),'a reconciler whose lease lapsed stops before creating',r.err);
 check(during.length===0&&row?.status==='pending','no Mautic contact written under a lapsed lease; capture still pending',{during,row});
 const again=await reconciler(),after=(await inv()).find(c=>c.email===email);
 check(again.exit===0&&after?.outcome==='created'&&withEmail(email).length===1,'the next reconciler creates it exactly once',after);
 return {checks,out:{first:{exit:r.exit,err:r.err},during,after}};
}

if(process.argv[1]?.endsWith('/races.mjs')){
 const [section,label]=process.argv.slice(2),output=directory+'ownership/evidence/raw-capture/races/'+section+'-'+label+'.json';
 const sections={probe:async()=>({checks:await probe()}),window:windowRace,poison,faults,collation,stall};
 if(!sections[section]||!/^[a-z0-9-]+$/.test(label??'')||existsSync(output))throw Error('usage: races.mjs probe|window|poison <new-label>');
 mkdirSync(directory+'ownership/evidence/raw-capture/races/',{recursive:true});
 let result;try{result=await sections[section]();}catch(e){result={checks:[{ok:false,name:section+' threw',detail:String(e.message).slice(0,300)}]};}
 const failed=result.checks.filter(c=>!c.ok).map(c=>c.name);writeFileSync(output,JSON.stringify({section,label,at:new Date().toISOString(),status:failed.length?'FAIL':'PASS',failed,...result},null,1)+'\n',{flag:'wx'});
 console.log((failed.length?'FAIL ':'PASS ')+(result.checks.length-failed.length)+'/'+result.checks.length+(failed.length?'\n  '+failed.join('\n  '):''));process.exitCode=failed.length?1:0;
}
