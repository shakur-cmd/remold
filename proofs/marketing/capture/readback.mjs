import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {anyApi} from 'convex/server';
try{
 const auth=JSON.parse(readFileSync(process.argv[2])),expected=JSON.parse(readFileSync(process.argv[3]));
 const client=new ConvexHttpClient('http://127.0.0.1:3620',{logger:false});
 for(const t of ['a','b'])assert.deepEqual(await client.query(anyApi.importer.snapshot,{instance:auth.bindings[t],key:auth.keys[t]}),expected[t]);
 console.log('PASS fresh process recovers both instance snapshots using only retained proof credentials.');
}catch{console.error('Private capture readback failed; no credential or data values printed.');process.exitCode=1;}
