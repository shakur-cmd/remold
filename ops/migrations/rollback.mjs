export function assertRollbackTarget(declaredHash, targetHash, expandedSchemaHash, targetSchemaHash) {
  if (targetHash !== declaredHash) throw new Error('Rollback target is not the declared expand release');
  if (targetSchemaHash !== expandedSchemaHash) throw new Error('Rollback schema does not retain the expansion');
}
