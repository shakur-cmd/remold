import assert from 'node:assert/strict';
export function verifiedReplyReference(receipt,metadata){
 assert.equal(receipt.name,'P1');assert.equal(metadata.id,receipt.providerRef);assert.equal(metadata.threadId,receipt.thread);
 const headers=Object.fromEntries(metadata.payload.headers.map(h=>[h.name.toLowerCase(),h.value]));
 assert.equal(headers.from,'shakur@envoylogic.com');assert.equal(headers.to,'reply@repliedfor.com');
 assert.match(headers['message-id'],/^<[A-Za-z0-9_=+./-]+@mail\.gmail\.com>$/);
 return headers['message-id'];
}
