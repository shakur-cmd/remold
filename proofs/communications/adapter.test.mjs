import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchReply, receiveHint, authorizeLiveSend, authorizeCalendar, draftMail, calendarProposal, Traversal } from './adapter.mjs';
const sent = { org: 'A', binding: 'mail-A', account: 'google-sub-A', mailbox: 'owner@example.invalid', contact: 'p@example.invalid', thread: 'thread-1', messageId: '<sent-1@example.invalid>', sequence: 'sequence-P', replyOwner: 'personal-sales' };
const message = { org: 'A', binding: 'mail-A', account: 'google-sub-A', mailbox: 'owner@example.invalid', from: 'p@example.invalid', to: ['owner@example.invalid'], thread: 'thread-1', inReplyTo: '<sent-1@example.invalid>', references: [], id: 'reply-1', text: 'Yes', autoSubmitted: false };
test('a stripped plain-text reply matches verified account, recipient and conversation without body quoting', () => {
  assert.equal(matchReply([sent], message)?.sequence, 'sequence-P');
});
test('a foreign mailbox, unknown address or wrong conversation never invents a match', () => {
  for (const patch of [{org:'B'},{binding:'mail-B'},{account:'google-sub-B'},{from:'unknown@example.invalid'},{to:['other@example.invalid']},{thread:'other'},{inReplyTo:'<other@example.invalid>'},{autoSubmitted:true}]) assert.equal(matchReply([sent], {...message,...patch}), null);
});
test('ambiguous ownership between personal and marketing sequences fails closed', () => {
  assert.equal(matchReply([sent,{...sent,sequence:'marketing-P',replyOwner:'marketing'}],message),null);
});
test('unreleased test run and absent calendar authorization cannot be bypassed by a token or recipient',()=>{
  assert.throws(()=>authorizeLiveSend({token:'synthetic',recipient:'reply@repliedfor.com',cap:5}),/TEST_NOT_RELEASED/);
  assert.throws(()=>authorizeCalendar({calendar:'primary'}),/NOT_AUTHORIZED/);
  assert.equal(draftMail({from:'A@example.invalid',to:'B@example.invalid',subject:'Test',text:'Synthetic'}).sent,false);
  assert.throws(()=>draftMail({from:'a@example.invalid',to:'b@example.invalid',subject:'Test\r\nBcc: x',text:'x'}),/INVALID_DRAFT/);
  assert.throws(()=>calendarProposal({calendar:'fixture',eventId:'existing',startsAt:1,endsAt:2}),/EXPECTED_VERSION/);
});
test('forged or account-switched notifications cannot invoke the authenticated pull',async()=>{
  let pulls=0;const pull=async()=>{pulls++;return[]};
  for(const [authenticated,emailAddress]of [[false,'owner@example.invalid'],[true,'foreign@example.invalid']])await assert.rejects(receiveHint({authenticated,expectedMailbox:'owner@example.invalid',hint:{emailAddress},pull}),/UNTRUSTED/);
  assert.equal(pulls,0);await receiveHint({authenticated:true,expectedMailbox:'owner@example.invalid',hint:{emailAddress:'owner@example.invalid',historyId:'untrusted'},pull});assert.equal(pulls,1);
});
test('interrupted traversal never advances cursor; replay deduplicates; expired history does not trigger broad import',()=>{
  const t=new Traversal('A','100'),page={binding:'A',from:'100',traversal:'run1',page:0,items:[{id:'m1',text:'fixture'}],end:false,checkpoint:'200'};
  t.page(page);assert.equal(t.cursor,'100');assert.equal(t.items.size,0);t.restart();
  t.page({...page,traversal:'run2'});t.page({...page,traversal:'run2',page:1,end:true});assert.equal(t.cursor,'200');assert.equal(t.items.size,1);
  assert.throws(()=>t.page({...page,binding:'B',from:'200'}),/BINDING/);
  assert.throws(()=>t.historyExpired(),/RESYNC_REQUIRES_APPROVAL/);assert.equal(t.cursor,'200');
});
