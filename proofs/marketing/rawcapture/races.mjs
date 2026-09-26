// Reconciler and store checks on tenant A only (db-b sits near its memory limit). One-shot per label.
//   window: an admin creates the same email, with DNC, while the reconciler pauses between lookup and create.
//   poison: captures Mautic refuses or that a LIKE search over-matches must not stop the captures behind them.
//   probe:  Convex-only refusals (input validation, re-settle, lease fencing); no Mautic call at all.
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {directory,prefix,docker} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {keys,query,mutation} from './runtime.mjs';
export const K=keys(),hex=n=>randomBytes(n).toString('hex');
const sql=q=>docker(['exec',prefix+'-db-a','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
const withEmail=e=>sql(`SELECT id,COALESCE(firstname,'') FROM leads WHERE email='${e.replace(/[^A-Za-z0-9@._+-]/g,'')}' ORDER BY id`).split('\n').filter(Boolean).map(l=>{const [id,firstname]=l.split('\t');return {id:Number(id),firstname};});
const ok=r=>{if(r.status<200||r.status>=300)throw Error('Mautic API refused '+r.status);return r.data;};
const reconciler=(env={},onStderr=()=>{})=>new Promise(r=>{const p=spawn(process.execPath,[directory+'rawcapture/reconcile.mjs','a'],{env:{...process.env,...env}});let o='',e='';p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>{e+=d;onStderr(e);});p.on('close',c=>{let log=null;try{log=JSON.parse(o.trim());}catch{}r({exit:c,log,err:(e.split('\n').find(l=>/Error/.test(l))??'').slice(0,200)});});});
const capture=(email,firstname)=>mutation('capture:capture',{key:K.a.edge,idempotencyKey:hex(16),email,firstname});
const inv=async()=>query('capture:inventory',{key:K.a.reconciler});
async function refused(fn){try{await fn();return null;}catch(e){return e.code??e.message;}}

export async function probe(){
 const checks=[],check=(ok,name,detail)=>checks.push({ok:!!ok,name,detail});
 const before=(await inv()).length;
 const bad=['iv%pct@example.invalid','%@%.%','a*b@example.invalid','a b@example.invalid','a@b','a@@example.invalid','.a@example.invalid','a..b@example.invalid','a@-x.invalid','x@example.invalid\n',"o'neil@example.invalid",'a&b@example.invalid','x'.repeat(65)+'@example.invalid','a@'+'d'.repeat(250)+'.invalid'];
 for(const email of bad){const code=await refused(()=>capture(email,'Probe'));check(code==='invalid','store refuses email '+JSON.stringify(email),code);}
 for(const [label,args] of [['control char in first name',{email:'ok@example.invalid',firstname:'a\u0007b'}],['101-char first name',{email:'ok@example.invalid',firstname:'x'.repeat(101)}],['short nonce',{email:'ok@example.invalid',firstname:'',idempotencyKey:'abc'}]]){const code=await refused(()=>mutation('capture:capture',{key:K.a.edge,idempotencyKey:hex(16),...args}));check(code==='invalid','store refuses '+label,code);}
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
 const tag=randomUUID().slice(0,8),tooLong='long-'+tag+'-'+'x'.repeat(50)+'@example.invalid',under='_'+tag+'@example.invalid',good='good-'+tag+'@example.invalid';
 // Both pass strict syntax: Mautic caps email at 64 characters, and its LIKE search treats _ as a wildcard.
 for(const [e,n] of [[tooLong,'Too long for Mautic'],[under,'Underscore'],[good,'Good after poison']])await capture(e,n);
 const r=await reconciler(),rows=await inv(),row=e=>rows.find(c=>c.email===e);
 const out={reconciler:{exit:r.exit,err:r.err},tooLong:row(tooLong),underscore:row(under),good:row(good),contacts:{tooLong:withEmail(tooLong),underscore:withEmail(under),good:withEmail(good)}};
 check(r.exit===0,'reconciler completes despite poison',r.err);
 check(row(tooLong)?.outcome==='rejected'&&/400|422/.test(row(tooLong).reason??''),'email Mautic refuses is settled as rejected with the reason',row(tooLong));
 check(row(under)?.status==='settled'&&out.contacts.underscore.length===1&&row(under).contactId===out.contacts.underscore[0].id,'underscore email resolved by exact match, one contact',row(under));
 check(row(good)?.outcome==='created'&&out.contacts.good.length===1&&out.contacts.good[0].firstname==='Good after poison','capture behind the poison is created with its suggested name',out.contacts.good);
 check(rows.filter(c=>c.status==='pending').length===0,'nothing left pending on A');
 return {checks,out};
}

if(process.argv[1]?.endsWith('/races.mjs')){
 const [section,label]=process.argv.slice(2),output=directory+'ownership/evidence/raw-capture/races/'+section+'-'+label+'.json';
 if(!['probe','window','poison'].includes(section)||!/^[a-z0-9-]+$/.test(label??'')||existsSync(output))throw Error('usage: races.mjs probe|window|poison <new-label>');
 mkdirSync(directory+'ownership/evidence/raw-capture/races/',{recursive:true});
 let result;try{result=section==='probe'?{checks:await probe()}:section==='window'?await windowRace():await poison();}catch(e){result={checks:[{ok:false,name:section+' threw',detail:String(e.message).slice(0,300)}]};}
 const failed=result.checks.filter(c=>!c.ok).map(c=>c.name);writeFileSync(output,JSON.stringify({section,label,at:new Date().toISOString(),status:failed.length?'FAIL':'PASS',failed,...result},null,1)+'\n',{flag:'wx'});
 console.log((failed.length?'FAIL ':'PASS ')+(result.checks.length-failed.length)+'/'+result.checks.length+(failed.length?'\n  '+failed.join('\n  '):''));process.exitCode=failed.length?1:0;
}
