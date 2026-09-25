// Actual edge reads with client DNT:0/Sec-GPC:0 (plus tracking cookie), a benign query and a foreign Host. Counters before/after per tenant.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {directory} from '../../../../runtime.mjs';
import {request} from '../../../http.mjs';
import {nativeCounts} from '../../../read-effects-replay.mjs';
const fx=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json')),hosts={a:'tenant-a.marketing-proof.invalid',b:'tenant-b.marketing-proof.invalid'};
const h=b=>createHash('sha256').update(b).digest('hex'),rows=[];let pass=true;
for(const t of ['a','b']){
 const page='/'+fx.tenants[t].publicPageAlias,asset=new URL(fx.tenants[t].assetDownloadUrl).pathname,before=nativeCounts(t),reqs=[];
 const call=(label,o,expected)=>{const r=request(t,{container:'public',port:8080,host:hosts[t],...o});const ok=r.status===expected;pass&&=ok;reqs.push({label,method:o.method??'GET',path:o.path,expected,status:r.status,ok,bodySha256:h(r.body),bytes:r.body.length,setCookie:r.headers['set-cookie']??null,csp:r.headers['content-security-policy']??null});};
 const optOut={DNT:'0','Sec-GPC':'0',Cookie:'mtc_id=1; mtc_sid=untrusted','User-Agent':'Mozilla/5.0 iv-r2'};
 for(const path of [page,asset]){call('client DNT0/Sec-GPC0 GET',{path,headers:optOut},200);call('client DNT0/Sec-GPC0 HEAD',{path,method:'HEAD',headers:optOut},200);}
 call('benign query control',{path:asset+'?utm_source=x',headers:optOut},404);
 call('foreign Host control',{path:page,host:hosts[t==='a'?'b':'a'],headers:optOut},421);
 const after=nativeCounts(t),unchanged=JSON.stringify(after)===JSON.stringify(before);pass&&=unchanged;
 rows.push({tenant:t,before,after,countersUnchanged:unchanged,requests:reqs});
}
writeFileSync(process.argv[2],JSON.stringify({at:new Date().toISOString(),pass,rows},null,1)+'\n');
for(const r of rows){console.log(r.tenant,'countersUnchanged',r.countersUnchanged);for(const q of r.requests)console.log(' ',q.ok?'OK':'BAD',q.status,q.method,q.label,q.bytes+'B','cookie='+q.setCookie);}
if(!pass)process.exit(1);
