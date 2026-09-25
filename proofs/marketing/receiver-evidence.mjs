import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {docker,directory,prefix} from './runtime.mjs';
export function received(intent){
 assert.match(intent,/^[a-f0-9]{64}$/);
 const script=`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/received.sqlite',{readOnly:true});const r=d.prepare('SELECT * FROM deliveries WHERE intent=?').get(process.argv[1]);const attempts=d.prepare('SELECT outcome FROM attempts WHERE intent=? ORDER BY id').all(process.argv[1]);console.log(JSON.stringify(r?{...r,raw:Buffer.from(r.raw).toString('base64'),attempts}:{attempts}));`;
 return JSON.parse(docker(['exec',prefix+'-mime-sink','node','-e',script,intent]));
}
export function oracle(receipt){
 assert.ok(receipt.raw,'Receiver must have stored MIME bytes');
 const payload={intent:receipt.intent,raw:receipt.raw,sender:receipt.sender,recipient:receipt.recipient,recipients:1};
 const result=JSON.parse(execFileSync('python3',[directory+'mime-oracle.py'],{input:JSON.stringify(payload),encoding:'utf8'}));
 assert.equal(result.hash,receipt.hash);assert.equal(result.rawSha256,receipt.raw_sha);
 return result;
}
