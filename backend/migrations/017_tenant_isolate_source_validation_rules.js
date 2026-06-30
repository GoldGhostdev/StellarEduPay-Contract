'use strict';

/**
 * Migration 017: Tenant-isolate source validation rules
 *
 * Problem (#904)
 * ---------------
 * The original `sourcevalidationrules` collection had no `schoolId` field.
 * Rules were global, meaning a rule created by School A was visible to and
 * could affect payments for School B — a security issue.
 *
 * Changes
 * -------
 * 1. Drops the old global `name_1` unique index (if it exists).
 * 2. Creates a compound unique index on `{ schoolId, name }` so names are
 *    only unique within a school's rule set.
 * 3. Backfills any existing rules that lack `schoolId` by setting them to
 *    the value of env var `DEFAULT_SCHOOL_ID` (falls back to "SCH-DEFAULT").
 *    This preserves existing rules while making them owned by the default
 *    school.  Operators should review these rules after migration.
 *
 * Rollback
 * --------
 * The `down` function recreates the old global unique index and removes the
 * compound index.  It does NOT clear `schoolId` from documents — the data
 * change is considered safe to retain even after rollback.
 */

const VERSION = '017_tenant_isolate_source_validation_rules';

async function up(db) {
  const collection = db.collection('sourcevalidationrules');

  // 1. Drop the old global unique index on `name` if it exists
  try {
    await collection.dropIndex('name_1');
    console.log('[017] Dropped old global unique index on sourcevalidationrules.name');
  } catch (err) {
    if (err.codeName !== 'IndexNotFound') throw err;
    console.log('[017] Global name_1 index not found — skipping drop');
  }

  // 2. Create compound unique index { schoolId, name }
  await collection.createIndex(
    { schoolId: 1, name: 1 },
    { unique: true, name: 'schoolId_name_unique' }
  );
  console.log('[017] Created compound unique index on sourcevalidationrules.{schoolId, name}');

  // 3. Create index on schoolId for tenant-scoped queries
  await collection.createIndex({ schoolId: 1 }, { name: 'schoolId_1' });
  console.log('[017] Created index on sourcevalidationrules.schoolId');

  // 4. Backfill existing rules without a schoolId
  const defaultSchoolId = process.env.DEFAULT_SCHOOL_ID || 'SCH-DEFAULT';
  const result = await collection.updateMany(
    { schoolId: { $exists: false } },
    { $set: { schoolId: defaultSchoolId } }
  );
  if (result.modifiedCount > 0) {
    console.log(
      `[017] Backfilled ${result.modifiedCount} rules with schoolId="${defaultSchoolId}". ` +
      'REVIEW these rules — they were previously global and now owned by the default school.'
    );
  } else {
    console.log('[017] No rules needed backfilling');
  }
}

async function down(db) {
  const collection = db.collection('sourcevalidationrules');

  // Restore the old global unique index
  try {
    await collection.createIndex({ name: 1 }, { unique: true, name: 'name_1' });
    console.log('[017] Recreated global unique index on sourcevalidationrules.name');
  } catch (err) {
    console.warn('[017] Could not recreate name_1 index (may conflict with data):', err.message);
  }

  // Drop the compound index
  try {
    await collection.dropIndex('schoolId_name_unique');
    console.log('[017] Dropped compound index schoolId_name_unique');
  } catch (err) {
    if (err.codeName !== 'IndexNotFound') throw err;
  }

  // Drop the schoolId index
  try {
    await collection.dropIndex('schoolId_1');
    console.log('[017] Dropped schoolId_1 index');
  } catch (err) {
    if (err.codeName !== 'IndexNotFound') throw err;
  }
}

module.exports = { version: VERSION, up, down };
