import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery, internalAction } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import { api, internal } from './_generated/api';

async function actor(ctx: MutationCtx | QueryCtx, token: string) {
  const session = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique();
  const a = session?.actor && await ctx.db.get(session.actor);
  if (!a || a.state !== 'active') throw Error('invalid session');
  return a;
}
async function owner(ctx: MutationCtx | QueryCtx, token: string) {
  const a = await actor(ctx, token);
  if (a.kind !== 'human') throw Error('human owner required');
  const org = await ctx.db.get(a.org);
  if (!org || org.readonly) throw Error('readonly');
  return a;
}
async function ownTask(ctx: MutationCtx | QueryCtx, token: string, id: Id<'tasks'>) {
  const a = await actor(ctx, token), task = await ctx.db.get(id);
  if (!task || task.org !== a.org) throw Error('tenant denied');
  if (a.kind !== 'human' && task.assignee !== a._id) throw Error('task scope denied');
  return { a, task };
}
async function audit(ctx: MutationCtx, org: Id<'orgs'>, who: string, kind: string, resource: string) {
  await ctx.db.insert('events', { org, actor: who, kind, resource, at: Date.now() });
}
async function advance(ctx: MutationCtx, task: Doc<'tasks'>) {
  if (task.intervalMs && task.remaining > 1) {
    await ctx.db.patch(task._id, { status: 'ready', occurrence: task.occurrence + 1, remaining: task.remaining - 1, attempts: 0, operation: undefined });
    await ctx.scheduler.runAfter(task.intervalMs, internal.runner.tick, { id: task._id, generation: task.generation });
  } else {
    for (const dependent of await ctx.db.query('tasks').withIndex('org', q => q.eq('org', task.org)).collect()) {
      if (dependent.status === 'blocked' && dependent.dependsOn.includes(task._id)) await ctx.scheduler.runAfter(0, internal.runner.tick, { id: dependent._id, generation: dependent.generation });
    }
  }
}
const taskId = { id: v.id('tasks') };

export const hire = mutation({ args: { token: v.string(), name: v.string(), reportsTo: v.id('actors'), sessionToken: v.string() }, handler: async (ctx, args) => {
  const a = await owner(ctx, args.token), manager = await ctx.db.get(args.reportsTo);
  if (!manager || manager.org !== a.org || manager.state !== 'active') throw Error('tenant denied');
  if (await ctx.db.query('sessions').withIndex('token', q => q.eq('token', args.sessionToken)).unique()) throw Error('session collision');
  const id = await ctx.db.insert('actors', { org: a.org, name: args.name, kind: 'agent', state: 'active', epoch: 1 });
  await ctx.db.insert('sessions', { actor: id, token: args.sessionToken });
  await ctx.db.insert('reports', { org: a.org, actor: id, manager: manager._id });
  await audit(ctx, a.org, a._id, 'agent.hired', id);
  return { id, reportsTo: manager._id };
} });

export const fire = mutation({ args: { token: v.string(), target: v.id('actors') }, handler: async (ctx, args) => {
  const a = await actor(ctx, args.token), target = await ctx.db.get(args.target);
  if (a.kind !== 'human') throw Error('human owner required');
  if (!target || target.org !== a.org) throw Error('tenant denied');
  await ctx.runMutation(api.harness.revoke, args);
  const affected = new Set<Id<'actors'>>([target._id]);
  const reports = await ctx.db.query('reports').filter(q => q.eq(q.field('org'), a.org)).collect();
  for (let i = 0; i < reports.length; i++) for (const report of reports) if (affected.has(report.manager)) affected.add(report.actor);
  const tasks = await ctx.db.query('tasks').withIndex('org', q => q.eq('org', a.org)).collect();
  for (const task of tasks) {
    if (!affected.has(task.assignee) || ['done', 'failed'].includes(task.status)) continue;
    if (task.operation) await ctx.runMutation(api.harness.cancel, { token: args.token, id: task.operation });
    await ctx.db.patch(task._id, { status: 'paused', generation: task.generation + 1 });
    await audit(ctx, a.org, a._id, 'task.pausedByFiring', task._id);
  }
} });

export const reassign = mutation({ args: { token: v.string(), ...taskId, assignee: v.id('actors') }, handler: async (ctx, args) => {
  const a = await owner(ctx, args.token), { task } = await ownTask(ctx, args.token, args.id), target = await ctx.db.get(args.assignee);
  if (!target || target.org !== a.org || target.state !== 'active') throw Error('tenant denied');
  if (task.status !== 'paused') throw Error('explicit paused-work reassignment required');
  if (task.operation) {
    const op = await ctx.db.get(task.operation);
    if (!op || !['cancelled', 'refused'].includes(op.state) || !op.released || op.permitUsed) throw Error('resolve old outcome before reassignment');
  }
  await ctx.db.patch(task._id, { assignee: target._id, generation: task.generation + 1, status: 'ready', attempts: 0, operation: undefined });
  await audit(ctx, a.org, a._id, 'task.reassigned', task._id);
} });

export const create = mutation({
  args: { token: v.string(), assignee: v.id('actors'), binding: v.id('bindings'), title: v.string(), dependsOn: v.array(v.id('tasks')), maxAttempts: v.number(), intervalMs: v.optional(v.number()), occurrences: v.optional(v.number()), fault: v.optional(v.union(v.literal('none'), v.literal('retryOnce'), v.literal('loseResponse'), v.literal('holdBeforePermit'))) },
  handler: async (ctx, args) => {
    const a = await owner(ctx, args.token), target = await ctx.db.get(args.assignee), binding = await ctx.db.get(args.binding);
    if (!target || target.org !== a.org || target.state !== 'active' || !binding || binding.org !== a.org) throw Error('tenant denied');
    if (!Number.isSafeInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 3 || args.dependsOn.length > 5) throw Error('invalid bound');
    const occurrences = args.occurrences ?? 1;
    if (!Number.isSafeInteger(occurrences) || occurrences < 1 || occurrences > 3 || (args.intervalMs !== undefined && (!Number.isSafeInteger(args.intervalMs) || args.intervalMs < 100 || args.intervalMs > 60000))) throw Error('invalid recurrence');
    for (const id of args.dependsOn) if ((await ctx.db.get(id))?.org !== a.org) throw Error('tenant denied');
    const id = await ctx.db.insert('tasks', { org: a.org, assignee: target._id, createdBy: a._id, binding: binding._id, title: args.title, dependsOn: args.dependsOn, maxAttempts: args.maxAttempts, status: args.dependsOn.length ? 'blocked' : 'ready', generation: 1, occurrence: 1, attempts: 0, intervalMs: args.intervalMs, remaining: occurrences, fault: args.fault ?? 'none' });
    await audit(ctx, a.org, a._id, 'task.created', id);
    return id;
  },
});

export const task = query({ args: { token: v.string(), ...taskId }, handler: async (ctx, args) => (await ownTask(ctx, args.token, args.id)).task });
export const recover = mutation({ args: { token: v.string(), ...taskId }, handler: async (ctx, args) => {
  const { a, task } = await ownTask(ctx, args.token, args.id);
  if (a.kind !== 'human') throw Error('human owner required');
  if (task.status === 'done') return;
  const operation = task.operation && await ctx.db.get(task.operation);
  if (!['unknown', 'paused'].includes(task.status) || !operation || !['outcomeUnknown', 'confirmed'].includes(operation.state)) throw Error('unknown outcome required');
  if (operation.state === 'confirmed' && task.artifact) return;
  await ctx.scheduler.runAfter(0, internal.runner.lookup, { id: task._id });
  await audit(ctx, task.org, a._id, 'task.recoveryRequested', task._id);
} });
export const lookupContext = internalQuery({ args: taskId, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  if (!task?.operation || !['unknown', 'paused'].includes(task.status)) return null;
  const operation = await ctx.db.get(task.operation), binding = await ctx.db.get(task.binding);
  const effect = await ctx.db.query('stubEffects').withIndex('operation', q => q.eq('operation', task.operation!)).unique();
  if (!operation || !['outcomeUnknown', 'confirmed'].includes(operation.state) || !binding || !effect) return null;
  const adapter = (await ctx.db.query('sessions').collect()).find(s => s.adapterScope?.provider === binding.provider && s.adapterScope.environment === binding.environment && s.adapterScope.account === binding.account);
  if (!adapter) throw Error('missing synthetic adapter session');
  return { task, operation, effect, token: adapter.token };
} });
export const recovered = internalMutation({ args: { ...taskId, operation: v.id('operations'), artifact: v.string() }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id), operation = await ctx.db.get(args.operation);
  if (!task || task.operation !== args.operation || operation?.state !== 'confirmed') return;
  // A late receipt preserves a fired task's pause; it never starts a new run.
  await ctx.db.patch(task._id, { artifact: args.artifact, ...(task.status === 'unknown' ? { status: 'done' as const } : {}) });
  await audit(ctx, task.org, 'provider-lookup', 'task.recovered', task._id);
  if (task.status === 'unknown') await advance(ctx, task);
} });
export const lookup = internalAction({ args: taskId, handler: async (ctx, args) => {
  const c = await ctx.runQuery(internal.runner.lookupContext, args);
  if (!c) return;
  await ctx.runMutation(api.harness.reconcile, { token: c.token, id: c.operation._id, fence: c.operation.fence, step: c.operation.step, providerRef: c.effect.artifact, usage: 1 });
  await ctx.runMutation(internal.runner.recovered, { ...args, operation: c.operation._id, artifact: c.effect.artifact });
} });
export const start = mutation({ args: { token: v.string(), ...taskId }, handler: async (ctx, args) => {
  const { a, task } = await ownTask(ctx, args.token, args.id);
  if ((await ctx.db.get(a.org))?.readonly) throw Error('readonly');
  if (!['ready', 'blocked'].includes(task.status)) throw Error('task not startable');
  await ctx.scheduler.runAfter(0, internal.runner.tick, { id: task._id, generation: task.generation });
  await audit(ctx, task.org, a._id, 'task.started', task._id);
} });

export const tick = internalMutation({ args: { ...taskId, generation: v.number() }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  if (!task || task.generation !== args.generation || !['ready', 'blocked'].includes(task.status)) return;
  const a = await ctx.db.get(task.assignee), org = await ctx.db.get(task.org);
  if (!a || a.state !== 'active' || !org || org.readonly) { await ctx.db.patch(task._id, { status: 'paused' }); return; }
  for (const id of task.dependsOn) {
    if ((await ctx.db.get(id))?.status !== 'done') {
      await ctx.db.patch(task._id, { status: 'blocked' });
      return;
    }
  }
  await ctx.db.patch(task._id, { status: 'running', attempts: task.attempts + 1 });
  await ctx.scheduler.runAfter(0, internal.runner.execute, args);
} });

// Synthetic credentials belong only to this disposable contract proof. A hosted
// executor receives no session or adapter credential; production uses I1/P6.
export const context = internalQuery({ args: { ...taskId, generation: v.number() }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  if (!task || task.generation !== args.generation || task.status !== 'running') return null;
  const sessions = await ctx.db.query('sessions').collect(), binding = await ctx.db.get(task.binding);
  if (!binding) throw Error('missing binding');
  const actorToken = sessions.find(s => s.actor === task.assignee)?.token;
  const adapterToken = sessions.find(s => s.adapterScope?.provider === binding.provider && s.adapterScope.environment === binding.environment && s.adapterScope.account === binding.account)?.token;
  if (!actorToken || !adapterToken) throw Error('missing synthetic session');
  return { task, binding, actorToken, adapterToken };
} });
export const attach = internalMutation({ args: { ...taskId, generation: v.number(), operation: v.id('operations') }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  if (!task || task.generation !== args.generation || task.status !== 'running') throw Error('stale task generation');
  await ctx.db.patch(task._id, { operation: args.operation });
} });
export const effect = internalMutation({ args: { operation: v.id('operations'), key: v.string() }, handler: async (ctx, args) => {
  const old = await ctx.db.query('stubEffects').withIndex('operation', q => q.eq('operation', args.operation)).unique();
  if (old) return old.artifact;
  const artifact = `synthetic artifact ${args.operation}`;
  await ctx.db.insert('stubEffects', { ...args, artifact });
  return artifact;
} });
export const finish = internalMutation({ args: { ...taskId, generation: v.number(), status: v.union(v.literal('done'), v.literal('failed'), v.literal('ready'), v.literal('unknown'), v.literal('paused')), artifact: v.optional(v.string()) }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  if (!task || task.generation !== args.generation || task.status !== 'running') return;
  await ctx.db.patch(task._id, { status: args.status, artifact: args.artifact });
  await audit(ctx, task.org, task.assignee, `task.${args.status}`, task._id);
  if (args.status === 'ready') await ctx.scheduler.runAfter(100 * task.attempts, internal.runner.tick, { id: task._id, generation: task.generation });
  if (args.status === 'done') await advance(ctx, task);
} });

// Internal fault control makes the pre-dispatch firing race deterministic.
export const hold = internalMutation({ args: { ...taskId, generation: v.number() }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  if (!task || task.generation !== args.generation || task.status !== 'running') return false;
  await ctx.db.patch(task._id, { heldBeforePermit: true });
  return true;
} });
export const holdReady = internalQuery({ args: { ...taskId, generation: v.number() }, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.id);
  return !task || task.generation !== args.generation || task.status !== 'running' || task.holdReleased === true;
} });
export const releaseHold = internalMutation({ args: taskId, handler: async (ctx, args) => {
  await ctx.db.patch(args.id, { holdReleased: true });
  return true;
} });

export const execute = internalAction({ args: { ...taskId, generation: v.number() }, handler: async (ctx, args) => {
  const c = await ctx.runQuery(internal.runner.context, args);
  if (!c) return;
  const worker = `native:${c.task._id}:${c.task.generation}`;
  try {
    const id: Id<'operations'> = await ctx.runMutation(api.harness.propose, { token: c.actorToken, logical: `${c.task._id}:${c.task.generation}:${c.task.occurrence}`, binding: c.binding._id, capability: 'model.call', payload: { content: c.task.title, audience: [], audienceVersion: 1, destination: c.binding.account, schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 }, reservationUnits: 1, maxSteps: 1 });
    await ctx.runMutation(internal.runner.attach, { ...args, operation: id });
    if (c.task.fault === 'holdBeforePermit') {
      if (!await ctx.runMutation(internal.runner.hold, args)) return;
      const deadline = Date.now() + 10000;
      while (!await ctx.runQuery(internal.runner.holdReady, args)) {
        if (Date.now() >= deadline) throw Error('proof hold expired');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const claim: { fence: number; step: number } = await ctx.runMutation(api.harness.claim, { token: c.actorToken, id, worker });
    const permit = await ctx.runMutation(api.harness.permit, { token: c.adapterToken, id, ...claim, worker });
    if (c.task.fault === 'retryOnce' && c.task.attempts === 1) {
      await ctx.runMutation(api.harness.fail, { token: c.adapterToken, id, ...claim, retryable: true });
      await ctx.runMutation(internal.runner.finish, { ...args, status: c.task.attempts < c.task.maxAttempts ? 'ready' : 'failed' });
      return;
    }
    const { expires: _expires, maxUnits: _units, maxRecipients: _recipients, ...consume } = permit;
    const request = await ctx.runMutation(api.harness.consume, { token: c.adapterToken, ...consume });
    const artifact: string = await ctx.runMutation(internal.runner.effect, { operation: id, key: request.key });
    if (c.task.fault === 'loseResponse') {
      await ctx.runMutation(api.harness.unknown, { token: c.adapterToken, id, ...claim });
      await ctx.runMutation(internal.runner.finish, { ...args, status: 'unknown' });
      return;
    }
    await ctx.runMutation(api.harness.reconcile, { token: c.adapterToken, id, ...claim, providerRef: artifact, usage: 1 });
    await ctx.runMutation(internal.runner.finish, { ...args, status: 'done', artifact });
  } catch {
    await ctx.runMutation(internal.runner.finish, { ...args, status: 'paused' });
  }
} });

export const inspect = internalQuery({ args: { org: v.id('orgs') }, handler: async (ctx, args) => {
  const tasks = await ctx.db.query('tasks').withIndex('org', q => q.eq('org', args.org)).collect();
  const ops = new Set((await ctx.db.query('operations').collect()).filter(o => o.org === args.org).map(o => o._id));
  return { tasks, effects: (await ctx.db.query('stubEffects').collect()).filter(e => ops.has(e.operation)) };
} });
