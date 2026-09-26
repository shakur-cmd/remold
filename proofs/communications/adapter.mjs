const address = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export function matchReply(sent, message) {
  if (!message.id || message.autoSubmitted || !address(message.from)) return null;
  const matches = sent.filter(row => row.org === message.org && row.binding === message.binding
    && row.account === message.account && address(row.mailbox) === address(message.mailbox)
    && address(row.contact) === address(message.from) && message.to?.map(address).includes(address(row.mailbox))
    && row.thread === message.thread && (message.inReplyTo === row.messageId || message.references?.includes(row.messageId)));
  const owners = new Map(matches.map(row => [`${row.replyOwner}:${row.sequence}`,row]));
  return owners.size === 1 ? [...owners.values()][0] : null;
}

// Google notifications are hints. No state or suppression is accepted from their payload.
export async function receiveHint({ authenticated, expectedMailbox, hint, pull }) {
  if (!authenticated || address(hint.emailAddress) !== address(expectedMailbox)) throw new Error('UNTRUSTED_HINT');
  return pull();
}

// Owner approved reciprocal tests; this preparation has no released provider send path.
export const liveAllowance = Object.freeze({ sendsPerMailboxPerDay: 5, calendar: null });
export function authorizeLiveSend() { throw new Error('CONCRETE_TEST_NOT_RELEASED'); }
export function authorizeCalendar() { throw new Error('CALENDAR_NOT_AUTHORIZED'); }

export function draftMail({ from, to, subject, text }) {
  if (!from || !to || !subject || !text || [from,to,subject].some(s => /[\r\n]/.test(s))) throw new Error('INVALID_DRAFT');
  return { from: address(from), to: address(to), subject, text, state: 'local-draft', sent: false };
}
export function calendarProposal({ calendar, eventId, startsAt, endsAt, version }) {
  if (!calendar || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) throw new Error('INVALID_MEETING');
  if (eventId && !version) throw new Error('EXPECTED_VERSION_REQUIRED');
  return { calendar, eventId, startsAt, endsAt, version, state: 'proposal', providerWrite: false };
}

// SIM seam: a durable implementation must transact message deduplication and cursor commit.
export class Traversal {
  constructor(binding, cursor) { this.binding=binding; this.cursor=cursor; this.items=new Map(); this.pending=null; }
  page({binding,from,traversal,page,items,end,checkpoint}) {
    if (binding!==this.binding || from!==this.cursor) throw new Error('CURSOR_BINDING_MISMATCH');
    if (!this.pending) { if(page!==0)throw new Error('PAGE_GAP'); this.pending={id:traversal,page:0,items:new Map()}; }
    if(this.pending.id!==traversal || page!==this.pending.page)throw new Error('PAGE_GAP');
    for(const item of items) {
      const prior=this.pending.items.get(item.id) ?? this.items.get(item.id);
      if(prior && JSON.stringify(prior)!==JSON.stringify(item))throw new Error('MESSAGE_INTEGRITY');
      this.pending.items.set(item.id,item);
    }
    this.pending.page++;
    if(end) { for(const [id,item] of this.pending.items)this.items.set(id,item);this.cursor=checkpoint;this.pending=null; }
  }
  restart() { this.pending=null; }
  historyExpired() { this.pending=null; throw new Error('BOUNDED_RESYNC_REQUIRES_APPROVAL'); }
}
