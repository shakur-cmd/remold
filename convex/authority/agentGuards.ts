import type { Doc } from '../_generated/dataModel';
import type { Principal } from '../identity';
import { fail } from '../errors';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isStage = (object: Doc<'objects'>, field: Doc<'fields'>) => object.isStandard && object.key === 'opportunity' && field.key === 'stage' && field.type === 'select';
const final = (value: unknown) => value === 'won' || value === 'lost';

// Limits that hold even when an agent has a grant; people are never affected.
// An agent moves an opportunity's stage only forward in option order and leaves
// won or lost deals alone, and never writes a field an admin protected from agents.
// Values equal to what is stored are not writes. A delete clears every value, but
// only a won or lost deal or a protected value stored on the record blocks it.
export function agentGuard(principal: Principal, object: Doc<'objects'>, fields: Doc<'fields'>[], record: Doc<'records'> | null, values: Record<string, unknown> | 'delete') {
  if (!('agent' in principal)) return;
  const changes = values === 'delete' ? Object.fromEntries(Object.keys(record!.values).map(id => [id, null])) : values;
  for (const [id, to] of Object.entries(changes)) {
    const field = fields.find(f => f._id === id), from = record?.values[id];
    if (!field || same(from, to)) continue;
    if (field.protectedFromAgents) fail('FORBIDDEN', `${field.label} is protected from agents; a person must change it`, { fieldId: field._id });
    if (!isStage(object, field) || from == null) continue;
    if (final(from)) fail('FORBIDDEN', `Agents cannot change the stage of a won or lost ${object.label.toLowerCase()}`, { fieldId: field._id });
    const order = (field.options ?? []).map(o => o.id);
    if (values !== 'delete' && (to == null || order.indexOf(to as string) < order.indexOf(from as string))) fail('FORBIDDEN', 'Agents can only move a stage forward', { fieldId: field._id });
  }
}
