import assert from 'node:assert/strict';
import { Traversal } from './adapter.mjs';
// The existing SIM seam has no durable store; a new worker receives only its configured starting cursor.
let worker = new Traversal('synthetic-A', '100');
worker.page({ binding:'synthetic-A', from:'100', traversal:'first', page:0, items:[{id:'known',text:'synthetic'}], end:true, checkpoint:'200' });
assert.equal(worker.cursor,'200');
worker = new Traversal('synthetic-A', '100');
assert.equal(worker.cursor,'200','A process restart must retain the completed cursor');
assert.equal(worker.items.size,1,'A process restart must retain known messages');
