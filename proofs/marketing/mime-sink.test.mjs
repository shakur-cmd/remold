import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSink} from './mime-sink.mjs';
import {inspectMime} from './mime.mjs';
import {payload} from './mime-fixture.mjs';
const key='test-fixture-key-'.repeat(4),config={key,sender:'sender@example.invalid',recipient:'recipient@example.invalid'};
async function serve(path,extra={}){const sink=createSink({...config,...extra},path);await new Promise(resolve=>sink.server.listen(0,'127.0.0.1',resolve));return{...sink,url:'http://127.0.0.1:'+sink.server.address().port,close:async()=>{await new Promise(resolve=>sink.server.close(resolve));sink.db.close();}};}
const post=(sink,data)=>fetch(sink.url+'/deliver',{method:'POST',headers:{'x-remold-sink-key':key},body:JSON.stringify(data)});
test('a separate receiver commits exact bytes before ack, retains them after restart and refuses a second submission',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'remold-mime-sink-')),'sink.sqlite'),a=payload(),expected=inspectMime(a),data={...a,expected:expected.hash};let sink=await serve(path,{lostResponseOnce:true});
 try{await assert.rejects(post(sink,data));assert.deepEqual(Buffer.from(sink.db.prepare('SELECT raw FROM deliveries').get().raw),expected.bytes);assert.equal(sink.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,1);}finally{await sink.close();}
 sink=await serve(path);try{const r=await fetch(sink.url+'/receipts/'+a.intent,{headers:{'x-remold-sink-key':key}});assert.equal(r.status,200);assert.equal((await r.json()).rawSha256,expected.rawSha256);assert.equal((await post(sink,data)).status,409);assert.equal(sink.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);assert.equal(sink.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE outcome='duplicate-refused'").get().n,1);}finally{await sink.close();}
});
test('swapped body, subject, headers or envelope cannot borrow an approved hash',async()=>{
 const sink=await serve(join(mkdtempSync(join(tmpdir(),'remold-mime-refusal-')),'sink.sqlite')),a=payload(),expected=inspectMime(a).hash;
 const rawChange=(from,to)=>({...a,raw:Buffer.from(Buffer.from(a.raw,'base64').toString().replace(from,to)).toString('base64')});
 try{for(const bad of [payload({text:'Changed text'}),payload({subject:'Changed subject'}),rawChange('Subject:','Bcc: hidden@example.invalid\r\nSubject:'),rawChange(config.recipient,'other@example.invalid'),{...a,recipient:'other@example.invalid'},{...a,sender:'other@example.invalid'}])assert.equal((await post(sink,{...bad,expected})).status,409);assert.equal(sink.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);assert.equal(sink.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,6);assert.equal((await post(sink,{...a,expected})).status,200);}finally{await sink.close();}
});

test('the receiver refuses a boundary that changes how a mail parser reads approved parts',async()=>{
 const sink=await serve(join(mkdtempSync(join(tmpdir(),'remold-mime-boundary-')),'sink.sqlite'));
 try{for(const delimiter of ['--chosen \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Other content</p>','--chosen--']){
  const html='<p>Approved</p><!--\r\n'+delimiter+'\r\n--><p>Required footer</p>',a=payload({html}),changed=payload({html,boundary:'chosen'});
  assert.equal((await post(sink,{...changed,expected:inspectMime(a).hash})).status,409);
 }assert.equal(sink.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);}finally{await sink.close();}
});
