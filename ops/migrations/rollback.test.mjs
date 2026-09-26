import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRollbackTarget } from './rollback.mjs';
test('only the declared expand release with its retained schema can be a rollback target', () => {
  assertRollbackTarget('expand', 'expand', 'expanded-schema', 'expanded-schema');
  assert.throws(() => assertRollbackTarget('expand', 'old', 'expanded-schema', 'old-schema'), /declared/);
  assert.throws(() => assertRollbackTarget('expand', 'expand', 'expanded-schema', 'old-schema'), /schema/);
});
