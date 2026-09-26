// Raw-socket refusal cases against the installed edges (inside each edge container, port 8080). Test driver only.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {context,prefix} from '../../../../runtime.mjs';
const hosts={a:'tenant-a.marketing-proof.invalid',b:'tenant-b.marketing-proof.invalid'};
const script=`let i='';for await(const c of process.stdin)i+=c;const a=JSON.parse(i);const net=await import('node:net');const out=await new Promise(r=>{const s=net.connect(8080,'127.0.0.1');const ch=[];let done=false;const fin=e=>{if(done)return;done=true;r({raw:Buffer.concat(ch).toString('latin1').slice(0,4000),error:e??null});};s.on('data',d=>ch.push(d));s.on('end',()=>fin());s.on('close',()=>fin());s.on('error',e=>fin(e.code));s.setTimeout(8000,()=>{fin('timeout');s.destroy();});(async()=>{for(const p of a.parts){if(s.destroyed)break;s.write(Buffer.from(p,'base64'));await new Promise(r=>setTimeout(r,a.delay??0));}})();});console.log(JSON.stringify(out));`;
const raw=(t,parts,delay)=>JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-public-'+t,'node','--input-type=module','-e',script],{input:JSON.stringify({parts:parts.map(p=>Buffer.from(p).toString('base64')),delay}),encoding:'utf8'}));
const status=r=>{const m=/^HTTP\/1\.1 (\d{3})/.exec(r.raw);return m?Number(m[1]):null;};
const rows=[];
for(const t of ['a','b']){
 const H=hosts[t],form=raw(t,['GET /form/1 HTTP/1.1\r\nHost: '+H+'\r\nConnection: close\r\n\r\n']);const token=/name="t" value="([a-f0-9]{64})"/.exec(form.raw+'')?.[1]??(()=>{throw Error('no token rendered');})();
 const head=(extra='')=>'POST /form/1 HTTP/1.1\r\nHost: '+H+'\r\nContent-Type: application/x-www-form-urlencoded\r\nConnection: close\r\n'+extra;
 const email='iv-refuse-'+t+'@example.invalid',valid='email='+encodeURIComponent(email)+'&t='+token;
 const cl=b=>head('Content-Length: '+Buffer.byteLength(b)+'\r\n\r\n');
 const chunk=b=>Buffer.byteLength(b).toString(16)+'\r\n'+b+'\r\n';
 const cases=[
  ['chunked oversized (valid fields, firstname 20000 bytes, 10 chunks, no Content-Length)',[head('Transfer-Encoding: chunked\r\n\r\n'),chunk(valid+'&firstname='),...Array.from({length:10},()=>chunk('x'.repeat(2000))),'0\r\n\r\n'],413],
  ['chunked oversized, cap crossed before any terminator (edge must answer without full body)',[head('Transfer-Encoding: chunked\r\n\r\n'),chunk(valid+'&firstname='),chunk('x'.repeat(9000))],413],
  ['duplicate key via percent-encoded name %65mail',[cl(valid+'&%65mail=other%40example.invalid'),valid+'&%65mail=other%40example.invalid'],400],
  ['duplicate key via percent-encoded name first%6eame',[cl(valid+'&firstname=A&first%6eame=B'),valid+'&firstname=A&first%6eame=B'],400],
  ['native field injected via encoded brackets mauticform%5Bemail%5D',[cl(valid+'&mauticform%5Bemail%5D=x%40y.invalid'),valid+'&mauticform%5Bemail%5D=x%40y.invalid'],400],
  ['plus-encoded key "t+" treated as different key',[cl(valid+'&t+=1'),valid+'&t+=1'],400],
 ];
 for(const [name,parts,expected] of cases){const r=raw(t,parts);rows.push({tenant:t,case:name,expected,status:status(r),pass:status(r)===expected,socketError:r.error,responseHead:r.raw.split('\r\n\r\n')[0].split('\r\n').filter(l=>!/^date:/i.test(l))});}
 // Raw invalid UTF-8 byte 0xFF in firstname value, not percent-encoded; unit tests do not cover this.
 const bad=Buffer.concat([Buffer.from(valid+'&firstname=A'),Buffer.from([0xff]),Buffer.from('B')]);
 const r1=JSON.parse(execFileSync('docker',['--context',context,'exec','-i',prefix+'-public-'+t,'node','--input-type=module','-e',script],{input:JSON.stringify({parts:[Buffer.from(head('Content-Length: '+bad.length+'\r\n\r\n')).toString('base64'),bad.toString('base64')]}),encoding:'utf8'}));
 rows.push({tenant:t,case:'raw invalid UTF-8 byte 0xFF (not percent-encoded)',expected:400,status:status(r1),pass:status(r1)===400,responseHead:r1.raw.split('\r\n\r\n')[0].split('\r\n').filter(l=>!/^date:/i.test(l))});
 const smug=valid;const r2=raw(t,[head('Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n'),chunk(smug)+'0\r\n\r\n']);
 rows.push({tenant:t,case:'Content-Length plus Transfer-Encoding (request smuggling shape)',expected:400,status:status(r2),pass:status(r2)===400,responseHead:r2.raw.split('\r\n\r\n')[0].split('\r\n').filter(l=>!/^date:/i.test(l))});
}
writeFileSync(process.argv[2],JSON.stringify({at:new Date().toISOString(),rows},null,1)+'\n');
for(const r of rows)console.log(r.tenant,r.pass?'PASS':'FAIL',r.status,'expected',r.expected,'-',r.case);
