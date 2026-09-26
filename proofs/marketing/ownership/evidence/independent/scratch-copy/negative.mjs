import assert from 'node:assert/strict';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {execFileSync} from 'node:child_process';
import {context,prefix,directory,docker} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/runtime.mjs';
import {api} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/tenants/api.mjs';
import {nativeCounts} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/publishing/read-effects-replay.mjs';
const out=directory+'ownership/evidence/independent/negative-no-cookie.json';assert.ok(!existsSync(out),'single attempt only');
const state=JSON.parse(readFileSync(directory+'private/ownership-independent-first/state.json')),b=state.tenants.a;assert.ok(b.captureOnlyComplete);const formId=b.captureOnlyFormId;
const form=api('a','/forms/'+formId).data.form;assert.equal(form.actions.length,0);for(const f of form.fields)for(const k of ['mappedObject','mappedField','leadField'])assert.ok(f[k]==null||f[k]==='');
const members=()=>Number(docker(['exec',prefix+'-db-a','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "SELECT COUNT(*) FROM campaign_leads;"']).trim());
const before=nativeCounts('a'),mBefore=members(),canonBefore=api('a','/contacts/'+b.canonicalId).data.contact;
const row={email:'negative-'+state.fixture+'@example.invalid',firstname:'No cookie negative'};
// Identical to capture-only.mjs send() except the fixed Blocked-Tracking cookie header is absent.
const script=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const body=new URLSearchParams({'mauticform[formId]':String(a.id),'mauticform[formName]':a.alias,'mauticform[return]':'','mauticform[email]':a.row.email,'mauticform[firstname]':a.row.firstname});const r=await fetch('http://127.0.0.1/form/submit?formId='+a.id+'&ajax=1',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',DNT:'1','Sec-GPC':'1'},body,signal:AbortSignal.timeout(10000)});console.log(JSON.stringify({status:r.status,setCookie:r.headers.getSetCookie().map(c=>c.split('=')[0]),body:await r.json()}));`;
writeFileSync(out+'.attempt','started '+new Date().toISOString()+'\n',{flag:'wx'});
const resp=JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-web-a','node','--input-type=module','-e',script],{input:JSON.stringify({id:form.id,alias:form.alias,row}),encoding:'utf8'}));
const subs=api('a','/forms/'+formId+'/submissions?limit=100').data,captured=Object.values(subs.submissions).map(s=>({id:s.id,contactId:s.lead?.id??null,results:s.results}));
const neg=captured.filter(c=>c.results.email===row.email);const after=nativeCounts('a'),canonAfter=api('a','/contacts/'+b.canonicalId).data.contact;
let linked=null;if(neg[0]?.contactId){const c=api('a','/contacts/'+neg[0].contactId).data.contact;linked={id:c.id,email:c.fields.all.email??null,firstname:c.fields.all.firstname??null,dnc:c.doNotContact.length};}
const result={at:new Date().toISOString(),level:'SERVICE native tenant A single negative, raw form '+formId,headers:'DNT:1, Sec-GPC:1, no Blocked-Tracking cookie; otherwise identical to capture-only send()',response:{status:resp.status,success:resp.body.success,setCookieNames:resp.setCookie},negativeSubmission:neg,linkedContact:linked,before,after,campaignMemberships:{before:mBefore,after:members()},canonicalUnchanged:JSON.stringify([canonBefore.id,canonBefore.fields.all,canonBefore.doNotContact])===JSON.stringify([canonAfter.id,canonAfter.fields.all,canonAfter.doNotContact]),priorCaptureRowsStillUnlinked:captured.filter(c=>c.results.email!==row.email).every(c=>c.contactId===null)};
writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
