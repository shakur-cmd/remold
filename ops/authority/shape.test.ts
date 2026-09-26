import { expect, it } from 'vitest';
import { inboxAdd } from '../../convex/agentApi';
import { argumentsConform } from '../../convex/lib/shape';

// Convex logs the whole argument object when its own validator refuses a call, so
// every extra key must be caught here first (IV D8, round 2 R1).
it('refuses extra body keys even when they share a name with an Object.prototype member', () => {
  const body = { keyHash: 'h', text: 'x' };
  expect(argumentsConform(inboxAdd, body)).toEqual([]);
  for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'extra']) expect(argumentsConform(inboxAdd, { ...body, [key]: 'forwarded' }), key).toBeNull();
});
