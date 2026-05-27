'use strict';

/**
 * Migration 013: Add timezone field to schools
 * 
 * Backfills timezone: 'UTC' for all existing schools.
 */

const mongoose = require('mongoose');

async function up() {
  const db = mongoose.connection.db;
  const result = await db.collection('schools').updateMany(
    { timezone: { $exists: false } },
    { $set: { timezone: 'UTC' } }
  );
  console.log(`[Migration 013] Added timezone field to ${result.modifiedCount} schools`);
}

async function down() {
  const db = mongoose.connection.db;
  const result = await db.collection('schools').updateMany(
    { timezone: 'UTC' },
    { $unset: { timezone: '' } }
  );
  console.log(`[Migration 013] Removed timezone field from ${result.modifiedCount} schools`);
}

module.exports = { up, down };
