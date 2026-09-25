import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
const source = readFileSync(new URL('./sandbox-fixture.mjs',import.meta.url),'utf8');
const gate = source.slice(source.indexOf('const manifest ='),source.indexOf('const start =')).replaceAll('import.meta.url',JSON.stringify('file:///fixture/sandbox-fixture.mjs'));
const hash = x => createHash('sha256').update(x).digest('hex');
const aggregate = files => hash(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))));
function check({bytes='approved',files={'candidate.txt':hash('approved')},recorded=aggregate({'candidate.txt':hash('approved')}),approved=recorded}={}) {
    const manifest={files,aggregate:recorded},approval={aggregate:approved,localSource:'APPROVE',sandboxExecution:'APPROVE'};
    runInNewContext(gate,{assert,createHash,URL,readFileSync:url=>url.pathname.endsWith('/source.json')?JSON.stringify(manifest):url.pathname.endsWith('/approval.json')?JSON.stringify(approval):bytes});
}
test('the actual driver gate accepts only source bytes committed by the approved aggregate',()=>{
    check();
    assert.throws(()=>check({bytes:'changed'}));
    assert.throws(()=>check({bytes:'changed',files:{'candidate.txt':hash('changed')}}),'Updating the file hash must not preserve an approval for different source');
    assert.throws(()=>check({files:{}}),'Dropping files must invalidate the approved aggregate');
    assert.throws(()=>check({approved:'other'}));
});
