#!/usr/bin/env node
'use strict';

/**
 * Migration CLI
 *
 * Usage:
 *   node scripts/migrate.js          # run all pending migrations
 *   node scripts/migrate.js rollback # roll back the last applied migration
 */

require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const mongoose = require('mongoose');
const { runMigrations, rollback } = require('../backend/src/services/migrationRunner');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI is not set');
  process.exit(1);
}

const POOL_CONFIG = {
  maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE || process.env.DB_MAX_POOL_SIZE || '20', 10),
  minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE || '10', 10),
  maxIdleTimeMS: parseInt(process.env.DB_MAX_IDLE_TIME_MS || '30000', 10),
  connectTimeoutMS: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS || '45000', 10),
  serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
};

async function main() {
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

  const command = process.argv[2];
  if (command === 'rollback') {
    await rollback();
  } else {
    await runMigrations();
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
