import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifiedReplyReference} from './receipt-reference.mjs';
import {matchReply} from './adapter.mjs';
const receipt={name:'P1',providerRef:'known-id',thread:'known-thread',messageId:'<requested@example.invalid>'};
const metadata={id:'known-id',threadId:'known-thread',payload:{headers:[{name:'Message-ID',value:'<actual123@mail.gmail.com>'},{name:'From',value:'shakur@envoylogic.com'},{name:'To',value:'reply@repliedfor.com'}]}};
test('provider-rewritten Message-ID becomes the reference only for the exact accepted owned message',()=>{
 assert.equal(verifiedReplyReference(receipt,metadata),'<actual123@mail.gmail.com>');
 for(const changed of [{...metadata,id:'unrelated-id'},{...metadata,threadId:'unrelated-thread'},{...metadata,payload:{headers:metadata.payload.headers.map(h=>h.name==='To'?{...h,value:'other@example.invalid'}:h)}}])assert.throws(()=>verifiedReplyReference(receipt,changed));
});
test('actual reply matches corrected context; original generated reference and unrelated Q stay unmatched',()=>{
 const context={org:'o',binding:'b',account:'a',mailbox:'shakur@envoylogic.com',contact:'reply@repliedfor.com',thread:'known-thread',messageId:verifiedReplyReference(receipt,metadata),sequence:'P',replyOwner:'sales'};
 const incoming={...context,id:'reply-id',from:context.contact,to:[context.mailbox],inReplyTo:'<actual123@mail.gmail.com>'};
 assert.equal(matchReply([context],incoming)?.sequence,'P');
 assert.equal(matchReply([{...context,messageId:receipt.messageId}],incoming),null);
 assert.equal(matchReply([context],{...incoming,thread:'Q-thread',inReplyTo:'<Q@example.invalid>'}),null);
});
