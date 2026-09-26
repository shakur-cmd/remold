// IV attack 2: header/cookie smuggling and edge-path bypass against the deployed edges, over raw sockets.
import * as L from './lib.mjs';
const out={tenants:{}};
for(const t of ['a','b']){
 const formId=L.deployedFormId(t),token=await L.edgeToken(t),other=t==='a'?'b':'a',otherToken=await L.edgeToken(other),H=L.host(t),O='Origin: http://'+H+'\r\n';
 const owner=L.makeOwner(t,'smuggle'),p0=L.profile(t,owner.id),c0=L.counts(t),maxSub0=Number(L.sql(t,'SELECT COALESCE(MAX(id),0) FROM form_submissions'));
 const b=n=>L.formBody(owner.email,'Smuggle '+n,token),P=(n,extra='')=>L.post(t,'/form/'+formId,b(n),O+extra);
 const smuggle=[
  ['duplicate Cookie headers',P('dup','Cookie: mtc_id='+owner.id+'\r\nCookie: Blocked-Tracking=0\r\n'),200],
  ['lowercase cookie header',P('lower','cookie: Blocked-Tracking=0; mtc_id='+owner.id+'\r\n'),200],
  ['mixed-case cookie header',P('mixed','CoOkIe: Blocked-Tracking=0\r\n'),200],
  ['client DNT 0 and Sec-GPC 0',P('dnt','DNT: 0\r\nSec-GPC: 0\r\nCookie: Blocked-Tracking=0\r\n'),200],
  ['device id cookie',P('device','Cookie: mautic_device_id=abcdef1234567890abcdef; mtc_id='+owner.id+'; mtc_sid=x\r\n'),200],
  ['obs-fold continuation',P('fold','Cookie: a=b\r\n Blocked-Tracking=0\r\n'),400],
  ['X-Forwarded-For routing header',P('xff','X-Forwarded-For: 10.0.0.1\r\n'),400],
  ['mauticform key in body',L.post(t,'/form/'+formId,b('body')+'&mauticform%5Bemail%5D=x%40example.invalid',O),400],
  ['CRLF in firstname',L.post(t,'/form/'+formId,L.formBody(owner.email,'a\r\nCookie: Blocked-Tracking=0',token),O),400],
  ['whitespace in email',L.post(t,'/form/'+formId,L.formBody(owner.email+'\r\nX: y','x',token),O),400],
  ['pipelined keep-alive pair',P('pipe1').replace('Connection: close','Connection: keep-alive')+P('pipe2','Cookie: Blocked-Tracking=0\r\n'),'200,200'],
 ];
 const bypass=[
  ['trailing slash','/form/'+formId+'/'],['query string','/form/'+formId+'?x=1'],['double slash','//form/'+formId],['inner double slash','/form//'+formId],
  ['percent-encoded id','/form/%'+formId.toString().split('').map(d=>(0x30+Number(d)).toString(16)).join('%')],['dot segment','/./form/'+formId],['traversal to another form','/form/'+formId+'/../1'],
  ['encoded traversal','/form/'+formId+'%2f..%2f1'],['upper case','/FORM/'+formId],['absolute-form target','http://'+H+'/form/'+formId],['form 1','/form/1'],['another id','/form/'+(formId+1)],
  ['native submit path','/form/submit?formId='+formId+'&ajax=1'],['native submit form 1','/form/submit?formId=1'],
 ].map(([k,p])=>[k,L.post(t,p,b('bypass'),O),'404']);
 const cross=[
  ['other tenant token on this edge',L.post(t,'/form/'+formId,L.formBody(owner.email,'cross',otherToken),O),'403'],
  ['other tenant Host on this edge',L.post(t,'/form/'+formId,b('host')).replace('Host: '+H,'Host: '+L.host(other)),'421'],
  ['PUT on form path',P('put').replace(/^POST/,'PUT'),'404'],
  ['duplicate Host header',P('dh','Host: '+H+'\r\n'),'400|421'],
 ];
 const cases=[...smuggle,...bypass,...cross],results=L.rawRequests(t,cases.map(c=>c[1]));
 const rows=cases.map((c,i)=>({kind:c[0],expected:String(c[2]),statuses:results[i].statuses,error:results[i].error,match:new RegExp('^('+String(c[2])+')$').test(results[i].statuses.join(','))}));
 const p1=L.profile(t,owner.id),c1=L.counts(t),subs=L.sql(t,`SELECT id,form_id,COALESCE(lead_id,'null') FROM form_submissions WHERE id>${maxSub0} ORDER BY id`).split('\n').filter(Boolean);
 const accepted=rows.reduce((n,r)=>n+r.statuses.filter(s=>s===200).length,0);
 out.tenants[t]={formId,ownerId:owner.id,rows,accepted,newSubmissions:subs,ownerBefore:p0,ownerAfter:p1,countersBefore:c0,countersAfter:c1,
  verdict:{allAsExpected:rows.every(r=>r.match),submissionsEqualAccepted:subs.length===accepted,allUnlinked:subs.every(s=>s.endsWith('\tnull')),allOnAdmittedForm:subs.every(s=>s.split('\t')[1]===String(formId)),ownerUnchanged:JSON.stringify(p0)===JSON.stringify(p1),noNewContacts:c1.contacts===c0.contacts&&c1.anonymousContacts===c0.anonymousContacts}};
 console.log(t,JSON.stringify(rows.filter(r=>!r.match)),JSON.stringify(out.tenants[t].verdict),accepted,subs.length);
}
L.save('a2-smuggle-bypass',out);
