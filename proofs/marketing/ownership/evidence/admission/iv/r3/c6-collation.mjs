// IV r3: 201/200 logic under MySQL collation. leads.email is utf8mb4_unicode_ci, where josé = jose, straße = strasse,
// fullwidth = ASCII and trailing spaces pad. An existing suppressed owner has such an email (as an admin or import could
// store it); a public capture sends the plain-ASCII equivalent, which passes the strict edge rule.
import * as L from './lib3.mjs';
const sqlU=q=>L.docker(['exec',L.prefix+'-db-a','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql --default-character-set=utf8mb4 -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
const r=L.run,cases=[
 ['accent',`josé-${r}@example.invalid`,`jose-${r}@example.invalid`],
 ['sharp s',`straße-${r}@example.invalid`,`strasse-${r}@example.invalid`],
 ['fullwidth',`ｊｏ-${r}@example.invalid`,`jo-${r}@example.invalid`],
 ['trailing space',`pad-${r}@example.invalid `,`pad-${r}@example.invalid`],
 ['upper case (control)',`CASE-${r}@EXAMPLE.INVALID`,`case-${r}@example.invalid`],
];
const out={cases:[]};
for(const [kind,stored,captured] of cases){
 const owner=L.makeOwner('a','coll-'+kind.split(' ')[0]);
 // Name first, then the email by SQL last: Mautic's API strips non-ASCII from emails (see c6-collation.json), so such
 // an email can only exist if stored by another path (import, direct DB, older version). API status is recorded.
 L.ok(L.api('a','/contacts/'+owner.id+'/edit','PATCH',{firstname:'Owner '+kind}));
 const viaApi={status:L.api('a','/contacts/'+owner.id+'/edit','PATCH',{email:stored}).status,storedAs:sqlU('SELECT email FROM leads WHERE id='+owner.id)};
 sqlU(`UPDATE leads SET email='${stored}' WHERE id=${owner.id}`);
 const before={email:sqlU('SELECT CONCAT("[",email,"]") FROM leads WHERE id='+owner.id),profile:L.profile('a',owner.id)};
 out.cases.push({kind,ownerId:owner.id,storedVia:'sql',apiAttempt:viaApi,captured,before,status:(await L.postA([{email:captured,firstname:'Public '+kind}]))[0]});
}
const m0=L.mautic('a'),rec=await L.reconcile(),m1=L.mautic('a'),inv=await L.inventory('a');
for(const c of out.cases){
 const cap=inv.find(x=>x.email===c.captured&&x.firstname==='Public '+c.kind);
 c.capture={outcome:cap?.outcome,contactId:cap?.contactId};
 c.after={email:sqlU('SELECT CONCAT("[",email,"]") FROM leads WHERE id='+c.ownerId),profile:L.profile('a',c.ownerId)};
 c.contactsForCaptured=sqlU(`SELECT id FROM leads WHERE email='${c.captured}'`).split('\n').filter(Boolean).map(Number);
 c.ownerEmailRewritten=c.before.email!==c.after.email;c.ownerNameChanged=c.before.profile.firstname!==c.after.profile.firstname;c.dncKept=c.after.profile.doNotContact.length===1;
}
Object.assign(out,{reconciler:{exit:rec.exit,err:rec.err},mauticBefore:m0,mauticAfter:m1});
L.save3('c6-collation-sql'+(process.env.IV_LABEL?'-'+process.env.IV_LABEL:''),out);
console.log(JSON.stringify(out.cases.map(c=>({kind:c.kind,via:c.storedVia,post:c.status,capture:c.capture,before:c.before.email,after:c.after.email,rewritten:c.ownerEmailRewritten,nameChanged:c.ownerNameChanged,dnc:c.dncKept,contacts:c.contactsForCaptured}))),JSON.stringify(out.reconciler));
