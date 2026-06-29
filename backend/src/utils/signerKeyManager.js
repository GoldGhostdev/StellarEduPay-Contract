'use strict';

/**
 * Signer Key Manager — issue #844
 *
 * Provides encrypted storage and retrieval of Stellar secret keys for school
 * wallets. Secret keys are NEVER stored in plaintext — every value written to
 * the database (or any other store) is AES-256-GCM encrypted under a master
 * key that lives exclusively in the environment.
 *
 * Threat model
 * ────────────
 *  • Database compromise → encrypted blobs only; master key is not in the DB.
 *  • Env compromise       → attacker can decrypt; rotate SIGNER_MASTER_KEY and
 *                           call re-encrypt() to migrate all records.
 *  • Memory disclosure    → secret key is held in memory only while a Keypair
 *                           is actively needed; it is not cached.
 *
 * Wire format (stored in schoolModel.encryptedSigningKey)
 * ────────────────────────────────────────────────────────
 *   base64( <12-byte IV> || <ciphertext> || <16-byte GCM auth tag> )
 *   Ciphertext = AES-256-GCM( masterKey, IV, plaintext=secretKey )
 *
 * Environment variables
 * ─────────────────────
 *   SIGNER_MASTER_KEY   64-char hex string (32 bytes). REQUIRED to use this
 *                       module. Generate with:
 *                         node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Usage
 * ─────
 *   const { encryptSecretKey, decryptSecretKey, getKeypair } = require('./signerKeyManager');
 *
 *   // When onboarding a school:
 *   const blob = encryptSecretKey('SXXXXX...your-stellar-secret...');
 *   await School.updateOne({ schoolId }, { encryptedSigningKey: blob });
 *
 *   // When submitting a transaction on behalf of a school:
 *   const keypair = getKeypair(school.encryptedSigningKey);
 *   const mgr = new StellarTransactionManager({ signingKeypair: keypair });
 */

const crypto = require('crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_LENGTH = 64; // 32 bytes

// ── Master key loading ────────────────────────────────────────────────────────

/**
 * Load and validate the master encryption key from SIGNER_MASTER_KEY env var.
 * Throws a clear error rather than silently returning null — a missing key
 * means any operation requiring signing is impossible and should fail loudly.
 *
 * @returns {Buffer} 32-byte key buffer
 */
function getMasterKey() {
  const hex = process.env.SIGNER_MASTER_KEY;
  if (!hex) {
    throw new Error(
      '[signerKeyManager] SIGNER_MASTER_KEY is not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (hex.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `[signerKeyManager] SIGNER_MASTER_KEY must be a ${KEY_HEX_LENGTH}-character hex string (32 bytes).`,
    );
  }
  return Buffer.from(hex, 'hex');
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt a Stellar secret key for safe storage.
 *
 * @param {string} secretKey  Stellar secret key (S...).
 * @returns {string}          base64-encoded encrypted blob.
 * @throws {Error} if secretKey is not a valid Stellar secret key.
 */
function encryptSecretKey(secretKey) {
  if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
    throw new Error('[signerKeyManager] Provided value is not a valid Stellar secret key.');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });

  const ciphertext = Buffer.concat([
    cipher.update(secretKey, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Layout: IV || ciphertext || tag
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

/**
 * Decrypt an encrypted secret key blob produced by encryptSecretKey().
 *
 * @param {string} encryptedBlob  base64-encoded encrypted blob from the database.
 * @returns {string}              Plaintext Stellar secret key (S...).
 * @throws {Error} on decryption failure (wrong key, tampered ciphertext).
 */
function decryptSecretKey(encryptedBlob) {
  if (!encryptedBlob || typeof encryptedBlob !== 'string') {
    throw new Error('[signerKeyManager] encryptedBlob must be a non-empty string.');
  }

  let buf;
  try {
    buf = Buffer.from(encryptedBlob, 'base64');
  } catch {
    throw new Error('[signerKeyManager] encryptedBlob is not valid base64.');
  }

  // Minimum length: IV (12) + 1 byte ciphertext + tag (16)
  const minLength = IV_BYTES + 1 + TAG_BYTES;
  if (buf.length < minLength) {
    throw new Error(
      `[signerKeyManager] encryptedBlob is too short (${buf.length} bytes, expected ≥ ${minLength}).`,
    );
  }

  const key = getMasterKey();
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  let secretKey;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    secretKey = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    throw new Error(
      '[signerKeyManager] Decryption failed — wrong master key or tampered ciphertext.',
    );
  }

  if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
    throw new Error(
      '[signerKeyManager] Decrypted value is not a valid Stellar secret key. ' +
      'The master key may be wrong or the blob may be corrupted.',
    );
  }

  return secretKey;
}

// ── Keypair access ────────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted blob and return a Stellar Keypair ready for signing.
 * The returned Keypair holds the secret key in memory; callers should discard
 * the reference as soon as signing is complete.
 *
 * @param {string} encryptedBlob  Encrypted secret key from the DB.
 * @returns {import('@stellar/stellar-sdk').Keypair}
 */
function getKeypair(encryptedBlob) {
  const secretKey = decryptSecretKey(encryptedBlob);
  return Keypair.fromSecret(secretKey);
}

// ── Re-encryption (key rotation) ─────────────────────────────────────────────

/**
 * Re-encrypt a blob using the current SIGNER_MASTER_KEY after a key rotation.
 *
 * During rotation:
 *  1. Set SIGNER_MASTER_KEY_OLD=<old key> and SIGNER_MASTER_KEY=<new key>.
 *  2. Call reEncryptSecretKey(blob) for each school's encryptedSigningKey.
 *  3. Persist the returned new blob.
 *  4. Remove SIGNER_MASTER_KEY_OLD once all records are migrated.
 *
 * @param {string} oldEncryptedBlob  Blob encrypted under the OLD key.
 * @returns {string}                 Blob encrypted under the CURRENT key.
 */
function reEncryptSecretKey(oldEncryptedBlob) {
  const oldKeyHex = process.env.SIGNER_MASTER_KEY_OLD;
  if (!oldKeyHex) {
    throw new Error(
      '[signerKeyManager] SIGNER_MASTER_KEY_OLD must be set for key rotation. ' +
      'Set it to the previous SIGNER_MASTER_KEY value.',
    );
  }
  if (oldKeyHex.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(oldKeyHex)) {
    throw new Error(
      `[signerKeyManager] SIGNER_MASTER_KEY_OLD must be a ${KEY_HEX_LENGTH}-character hex string.`,
    );
  }

  // Temporarily override to decrypt with old key
  const originalEnv = process.env.SIGNER_MASTER_KEY;
  process.env.SIGNER_MASTER_KEY = oldKeyHex;
  let secretKey;
  try {
    secretKey = decryptSecretKey(oldEncryptedBlob);
  } finally {
    process.env.SIGNER_MASTER_KEY = originalEnv;
  }

  return encryptSecretKey(secretKey);
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Returns true when SIGNER_MASTER_KEY is present and correctly formatted.
 * Use this for health checks — avoids throwing.
 *
 * @returns {boolean}
 */
function isMasterKeyConfigured() {
  const hex = process.env.SIGNER_MASTER_KEY;
  return (
    typeof hex === 'string' &&
    hex.length === KEY_HEX_LENGTH &&
    /^[0-9a-fA-F]+$/.test(hex)
  );
}

module.exports = {
  encryptSecretKey,
  decryptSecretKey,
  getKeypair,
  reEncryptSecretKey,
  isMasterKeyConfigured,
};
