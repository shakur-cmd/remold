import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server';
import { v } from 'convex/values';
import { item } from './schema.js';
const address = value => value.trim().toLowerCase();
const same = (a,b) => a.id===b.id && a.from===b.from && a.text===b.text;
const get = async (ctx,id) => { const row=await ctx.db.get(id); if(!row)throw new Error('MAILBOX_MISSING'); return row; };
// Disposable local fixture only. These functions are not a product or provider adapter.
export const seed = mutation({args:{label:v.string()},handler:async(ctx,{label})=>ctx.db.insert('mailboxes',{
  label,cursor:'100',paused:false,pending:null,last:null,
  contacts:[{address:'known@example.invalid',contact:'contact-1'},{address:'ambiguous@example.invalid',contact:'contact-2'},{address:'ambiguous@example.invalid',contact:'contact-3'}],
})});
export const page = mutation({args:{mailbox:v.id('mailboxes'),from:v.string(),traversal:v.string(),page:v.number(),items:v.array(item),end:v.boolean(),checkpoint:v.string()},handler:async(ctx,a)=>{
  const box=await get(ctx,a.mailbox);
  if(box.paused)throw new Error('HISTORY_EXPIRED_PAUSED');
  if(!Number.isInteger(a.page)||a.page<0||a.page>=20||a.items.length>25||!a.traversal||!a.checkpoint)throw new Error('PAGE_BOUND');
  for(const i of a.items)if(!i.id||i.id.length>200||i.from.length>320||i.text.length>500)throw new Error('MESSAGE_BOUND');
  // Canonical receipt binds replay to all cursor and page contents, without trusting a caller digest.
  const fingerprint=JSON.stringify([a.from,a.traversal,a.page,a.items.map(i=>[i.id,i.from,i.text]),a.end,a.checkpoint]);
  if(box.last?.id===a.traversal){
    if(box.last.receipts[a.page]!==fingerprint)throw new Error('PAGE_REPLAY_CHANGED');
    return 'duplicate';
  }
  if(a.from!==box.cursor)throw new Error('CURSOR_MISMATCH');
  const p=box.pending??{id:a.traversal,from:a.from,receipts:[],items:[]};
  if(p.id!==a.traversal)throw new Error('TRAVERSAL_IN_PROGRESS');
  if(a.page<p.receipts.length){if(p.receipts[a.page]!==fingerprint)throw new Error('PAGE_REPLAY_CHANGED');return 'duplicate';}
  if(a.page!==p.receipts.length)throw new Error('PAGE_GAP');
  const staged=new Map(p.items.map(i=>[i.id,i]));
  for(const i of a.items){
    const stored=await ctx.db.query('messages').withIndex('by_mailbox_id',q=>q.eq('mailbox',box._id).eq('providerId',i.id)).unique();
    const prior=staged.get(i.id)??(stored?{id:stored.providerId,from:stored.from,text:stored.text}:null);
    if(prior&&!same(prior,i))throw new Error('MESSAGE_INTEGRITY');
    staged.set(i.id,i);
  }
  if(staged.size>100)throw new Error('TRAVERSAL_BOUND');
  p.items=[...staged.values()];p.receipts.push(fingerprint);
  if(!a.end){await ctx.db.patch(box._id,{pending:p});return 'staged';}
  if(a.checkpoint===a.from)throw new Error('CHECKPOINT_UNCHANGED');
  for(const i of p.items){
    const exists=await ctx.db.query('messages').withIndex('by_mailbox_id',q=>q.eq('mailbox',box._id).eq('providerId',i.id)).unique();
    if(!exists){
      const matches=[...new Set(box.contacts.filter(c=>address(c.address)===address(i.from)).map(c=>c.contact))];
      await ctx.db.insert('messages',{mailbox:box._id,providerId:i.id,from:i.from,text:i.text,contact:matches.length===1?matches[0]:null});
    }
  }
  // Final visibility and completed checkpoint change in the same Convex transaction.
  await ctx.db.patch(box._id,{cursor:a.checkpoint,pending:null,last:{id:p.id,from:p.from,receipts:p.receipts}});
  return 'committed';
}});
export const historyExpired = mutation({args:{mailbox:v.id('mailboxes')},handler:async(ctx,{mailbox})=>{
  const box=await get(ctx,mailbox);await ctx.db.patch(box._id,{paused:true,pending:null});return 'paused';
}});
export const snapshot = query({args:{mailbox:v.id('mailboxes')},handler:async(ctx,{mailbox})=>{
  const box=await get(ctx,mailbox),messages=await ctx.db.query('messages').withIndex('by_mailbox_id',q=>q.eq('mailbox',mailbox)).collect();
  return {cursor:box.cursor,paused:box.paused,pending:box.pending?{id:box.pending.id,pages:box.pending.receipts.length,count:box.pending.items.length}:null,messages:messages.map(({providerId,from,text,contact})=>({id:providerId,from,text,contact})).sort((a,b)=>a.id.localeCompare(b.id))};
}});
