#!/usr/bin/env node
'use strict';

/**
 * Seed script — populates the database with sample fee structures and students
 * for local development and testing.
 *
 * Usage:
 *   node scripts/seed-test-data.js           # upsert (safe default)
 *   node scripts/seed-test-data.js --clean   # drop collections then re-seed
 *
 * Requirements:
 *   - backend/.env must exist with MONGO_URI and SCHOOL_WALLET_ADDRESS set
 *   - MongoDB must be running
 *
 * Safe to re-run: all inserts use upsert so repeated runs produce identical records.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });

// Patch env so config/index.js validation passes when models are loaded
process.env.SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || 'PLACEHOLDER';

// Root and backend pin different mongoose majors in separate node_modules
// trees. A plain require('mongoose') here resolves to the root copy, which is
// a different singleton than the one FeeStructure/Student are bound to —
// mongoose.connect() below would then never open *their* connection, and every
// query buffers until it times out ("buffering timeout" — see issue #749).
const mongoose = require('../backend/node_modules/mongoose');
const FeeStructure = require('../backend/src/models/feeStructureModel');
const Student = require('../backend/src/models/studentModel');

const POOL_CONFIG = {
  maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE || process.env.DB_MAX_POOL_SIZE || '20', 10),
  minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '10', 10),
  maxIdleTimeMS: parseInt(process.env.DB_MAX_IDLE_TIME_MS || '30000', 10),
  connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS || '45000', 10),
  serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
};

// ── Seed data ─────────────────────────────────────────────────────────────────

const FEE_STRUCTURES = [
  { className: 'Grade 9',  feeAmount: 500,  description: 'Junior Secondary' },
  { className: 'Grade 10', feeAmount: 550,  description: 'Junior Secondary' },
  { className: 'Grade 11', feeAmount: 600,  description: 'Senior Secondary' },
  { className: 'Grade 12', feeAmount: 650,  description: 'Senior Secondary' },
];

const STUDENTS = [
  { studentId: 'STU001', name: 'Alice Johnson',   class: 'Grade 9'  },
  { studentId: 'STU002', name: 'Bob Martinez',    class: 'Grade 9'  },
  { studentId: 'STU003', name: 'Carol Williams',  class: 'Grade 10' },
  { studentId: 'STU004', name: 'David Osei',      class: 'Grade 10' },
  { studentId: 'STU005', name: 'Eva Mensah',      class: 'Grade 11' },
  { studentId: 'STU006', name: 'Frank Asante',    class: 'Grade 11' },
  { studentId: 'STU007', name: 'Grace Nkrumah',   class: 'Grade 12' },
  { studentId: 'STU008', name: 'Henry Boateng',   class: 'Grade 12' },
  // One student with a partial payment already recorded (for payment flow testing)
  { studentId: 'STU009', name: 'Irene Adjei',     class: 'Grade 12', totalPaid: 200, remainingBalance: 450 },
  // One student marked as fully paid (for dashboard/filter testing)
  { studentId: 'STU010', name: 'James Owusu',     class: 'Grade 9',  feePaid: true,  totalPaid: 500, remainingBalance: 0 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Upsert fee structures — update feeAmount/description if the class already
 * exists so re-runs stay consistent.
 */
async function seedFeeStructures() {
  console.log('\n📋  Seeding fee structures…');
  const feeMap = {};

  for (const fee of FEE_STRUCTURES) {
    const doc = await FeeStructure.findOneAndUpdate(
      { className: fee.className },
      { ...fee, isActive: true },
      { upsert: true, new: true, runValidators: true }
    );
    feeMap[doc.className] = doc.feeAmount;
    console.log(`   ✔  ${doc.className} — $${doc.feeAmount} USDC`);
  }

  return feeMap;
}

/**
 * Upsert students by studentId — consistent with the fee structure approach.
 * Resolves feeAmount from the fee map so the seed is self-contained.
 */
async function seedStudents(feeMap) {
  console.log('\n🎓  Seeding students…');

  for (const s of STUDENTS) {
    const feeAmount = feeMap[s.class];
    if (!feeAmount) {
      console.warn(`   ⚠️   No fee structure found for class "${s.class}" — skipping ${s.studentId}`);
      continue;
    }

    await Student.findOneAndUpdate(
      { studentId: s.studentId },
      { feeAmount, ...s },
      { upsert: true, new: true, runValidators: true }
    );
    console.log(`   ✔  ${s.studentId} — ${s.name} (${s.class}, $${feeAmount} USDC)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const clean = process.argv.includes('--clean');
  const MONGO_URI = process.env.MONGO_URI;

  console.log('🌱  StellarEduPay — test data seed');
  console.log(`    MongoDB: ${MONGO_URI}`);
  if (clean) console.log('    Mode: --clean (dropping collections before re-seeding)');

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: POOL_CONFIG.maxPoolSize,
    minPoolSize: POOL_CONFIG.minPoolSize,
    maxIdleTimeMS: POOL_CONFIG.maxIdleTimeMS,
    connectTimeoutMS: POOL_CONFIG.connectTimeoutMS,
    socketTimeoutMS: POOL_CONFIG.socketTimeoutMS,
    serverSelectionTimeoutMS: POOL_CONFIG.serverSelectionTimeoutMS,
    retryWrites: true,
    retryReads: true,
    w: 'majority',
    readPreference: 'primaryPreferred',
  });
  console.log('    Connected to MongoDB');

  if (clean) {
    await FeeStructure.deleteMany({});
    await Student.deleteMany({});
    console.log('    Collections dropped.');
  }

  const feeMap = await seedFeeStructures();
  await seedStudents(feeMap);

  console.log('\n✅  Done.');
  console.log('\n    Quick test commands:');
  console.log('      GET  http://localhost:5000/api/students');
  console.log('      GET  http://localhost:5000/api/fees');
  console.log('      GET  http://localhost:5000/api/students/STU001\n');
}

// Only validate env and run when executed directly (not when require()'d by tests)
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error('❌  MONGO_URI is not set. Check backend/.env');
    process.exit(1);
  }

  main()
    .catch((err) => {
      console.error('\n❌  Seed failed:', err.message);
      process.exit(1);
    })
    .finally(() => mongoose.disconnect());
}

module.exports = { seedFeeStructures, seedStudents, FEE_STRUCTURES, STUDENTS };
