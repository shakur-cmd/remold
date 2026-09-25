import { httpAction } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import { argumentsConform } from '../lib/shape';
import * as dispatch from './dispatch';
import * as outcomes from './outcomes';
import * as safety from './safety';
import * as receipts from './receipts';
import * as bindings from './bindings';
import * as callbacks from './callbacks';
import * as lookups from './lookups';
import * as safetyFinality from './safetyFinality';
const modules: Record<string, Record<string, unknown>> = { 'integrations/dispatch': dispatch, 'integrations/outcomes': outcomes, 'integrations/safety': safety, 'integrations/receipts': receipts, 'integrations/bindings': bindings, 'integrations/callbacks': callbacks, 'integrations/lookups': lookups, 'integrations/safetyFinality': safetyFinality };
const functionFor = (name: string) => { const [module, fn] = name.split(':'); return modules[module!]?.[fn!]; };
const status: Record<string, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 400, UNSUPPORTED: 503 };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
const mutations: Record<string, string> = {
  permit: 'integrations/dispatch:permit', consume: 'integrations/dispatch:consume',
  unknown: 'integrations/outcomes:unknown', reconcile: 'integrations/outcomes:reconcile', fail: 'integrations/outcomes:fail',
  'safety-begin': 'integrations/safety:beginTarget', 'safety-complete': 'integrations/safety:completeTarget', 'safety-receipt': 'integrations/receipts:observe',
  'resolve-unknown': 'integrations/outcomes:resolveUnknown', bind: 'integrations/bindings:bind', page: 'integrations/callbacks:page',
};
export const route = httpAction(async (ctx, request) => {
  try {
    const key = /^Bearer (ra_[0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!key) return json({ error: { code: 'UNAUTHENTICATED', message: 'Adapter credential required' } }, 401);
    const credentialHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const name = new URL(request.url).pathname.slice('/api/integrations/v1/'.length), text = await request.text();
    if (text.length > 131072) return json({ error: { code: 'VALIDATION', message: 'Request too large' } }, 413);
    let body: unknown; try { body = JSON.parse(text); } catch { return json({ error: { code: 'VALIDATION', message: 'Expected JSON body' } }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: { code: 'VALIDATION', message: 'Expected object' } }, 400);
    // Only the authenticated header selects the adapter. Validators reject tenant/actor substitutions.
    const args = { ...body, credentialHash };
    const target = name === 'safety-resolve-unknown' ? 'integrations/safetyFinality:resolve' : name === 'lookup' ? 'integrations/lookups:seal' : name === 'callback' ? 'integrations/callbacks:callback' : name === 'status' ? 'integrations/dispatch:status' : mutations[name];
    if (!target) return json({ error: { code: 'NOT_FOUND' } }, 404);
    // Refuse malformed bodies here: a validator failure inside the call would log every argument, key hash included.
    const ids = argumentsConform(functionFor(target), args);
    if (!ids || (ids.length && !await ctx.runQuery(makeFunctionReference<'query'>('lib/shape:idsBelong'), { ids }))) return json({ error: { code: 'VALIDATION', message: 'Invalid adapter arguments' } }, 400);
    if (name === 'safety-resolve-unknown') return json(await ctx.runAction(makeFunctionReference<'action'>('integrations/safetyFinality:resolve'), args));
    if (name === 'lookup') return json(await ctx.runAction(makeFunctionReference<'action'>('integrations/lookups:seal'), args));
    if (name === 'callback') return json(await ctx.runAction(makeFunctionReference<'action'>('integrations/callbacks:callback'), args));
    if (name === 'status') return json(await ctx.runQuery(makeFunctionReference<'query'>('integrations/dispatch:status'), args));
    const fn = mutations[name]; if (!fn) return json({ error: { code: 'NOT_FOUND' } }, 404);
    return json(await ctx.runMutation(makeFunctionReference<'mutation'>(fn), args));
  } catch (error) {
    const e = error as { data?: { code?: string }; message?: string };
    if (e.data?.code) return json({ error: e.data }, status[e.data.code] ?? 500);
    if (/ArgumentValidationError|Validator error/.test(e.message ?? '')) return json({ error: { code: 'VALIDATION', message: 'Invalid adapter arguments' } }, 400);
    return json({ error: { code: 'INTERNAL', message: 'Integration request failed' } }, 500);
  }
});
