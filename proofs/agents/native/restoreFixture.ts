// Copied into only the disposable restore project, not the normal native runner.
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
const tables = ['budgets','orgs','actors','sessions','grants','bindings','operations','consent','events','callbacks','observations','provisions','cursors','records','tasks','reports','stubEffects'] as const;
export const snapshot = internalQuery({args:{},handler:async ctx=>{
  const rows:Record<string,unknown[]>={};
  for(const table of tables)rows[table]=await ctx.db.query(table).collect();
  return rows;
}});
export const store = internalAction({args:{ciphertext:v.string()},handler:async(ctx,{ciphertext})=>ctx.storage.store(new Blob([ciphertext],{type:'application/octet-stream'}))});
export const file = internalAction({args:{id:v.id('_storage')},handler:async(ctx,{id})=>{
  const blob=await ctx.storage.get(id);if(!blob)throw Error('RESTORED_FILE_MISSING');return blob.text();
}});
// The existing runner has no no-receipt fault. This synthetic fixture represents
// a consumed attempt with no known provider result; it must not become done on restore.
export const unresolvedTask = internalMutation({args:{id:v.id('tasks'),operation:v.id('operations')},handler:async(ctx,{id,operation})=>{
  const task=await ctx.db.get(id),op=await ctx.db.get(operation);
  if(!task||task.status!=='ready'||!op||op.org!==task.org||op.state!=='outcomeUnknown'||!op.permitUsed)throw Error('INVALID_UNRESOLVED_FIXTURE');
  await ctx.db.patch(id,{operation,status:'unknown',attempts:1});
}});
