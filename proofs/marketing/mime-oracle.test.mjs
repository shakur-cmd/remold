import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {payload} from './mime-fixture.mjs';
const oracle=p=>execFileSync('python3',[fileURLToPath(new URL('./mime-oracle.py',import.meta.url))],{input:JSON.stringify(p),encoding:'utf8',stdio:['pipe','pipe','pipe']});
test('the independent MIME parser preserves the pixel query and rejects truncated approved HTML',()=>{
 const html='<img src="http://localhost:3540/email/Tracking123.gif?ct=abc&amp;x=2"><!--\r\n--chosen--\r\n--><p>Required footer</p>'.replaceAll('=','=3D');
 assert.equal(JSON.parse(oracle(payload({html}))).pixel,'http://localhost:3540/email/Tracking123.gif?ct=abc&x=2');
 assert.throws(()=>oracle(payload({html,boundary:'chosen'})),error=>/outside MIME parts|changed the approved part body/.test(String(error.stderr)));
});
