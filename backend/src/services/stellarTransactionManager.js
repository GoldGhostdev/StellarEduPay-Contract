'use strict';

/**
 * Stellar Transaction Manager — issue #843
 *
 * Handles outgoing Stellar transactions (refunds, sweeps, account setup) with:
 *
 *  1. Timebounds   — every submitted transaction carries a maxTime so it
 *                    cannot be replayed or remain pending indefinitely.
 *                    Controlled by STELLAR_TX_TIMEOUT_SECONDS (default 300 s).
 *
 *  2. Sequence mgmt — loads the current account sequence fresh from Horizon
 *                    before every build, retries once on SEQUENCE_ERROR to
 *                    handle clock skew or parallel submission races.
 *
 *  3. Fee-bump      — if a submitted transaction is stuck (tx_insufficient_fee
 *                    or times out in the pending pool) the caller can wrap it
 *                    with submitFeeBump(), which builds a fee-bump envelope
 *                    signed by a separate fee-source account and resubmits.
 *
 * Usage:
 *   const mgr = new StellarTransactionManager({ signingKeypair, feeSourceKeypair });
 *   const result = await mgr.buildAndSubmit(operations, options);
 *   // On fee surge / timeout:
 *   await mgr.submitFeeBump(innerTxEnvelope, { feeMultiplier: 5 });
 */

const {
  TransactionBuilder,
  Networks,
  BASE_FEE,
} = require('@stellar/stellar-sdk');
const { server, networkPassphrase } = require('../config/stellarConfig');
const { withStellarRetry } = require('../utils/withStellarRetry');
const logger = require('../utils/logger').child('StellarTxManager');

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TX_TIMEOUT_SECONDS = parseInt(
  process.env.STELLAR_TX_TIMEOUT_SECONDS || '300',
  10,
);
const DEFAULT_BASE_FEE_STROOPS = parseInt(
  process.env.STELLAR_TX_BASE_FEE || String(BASE_FEE),
  10,
);
const DEFAULT_FEE_MULTIPLIER = parseFloat(
  process.env.STELLAR_TX_FEE_MULTIPLIER || '1.5',
);
const MAX_FEE_BUMP_MULTIPLIER = 20; // safety cap

// Horizon result codes that indicate a stale/bad sequence number
const SEQUENCE_ERROR_CODES = new Set([
  'tx_bad_seq',
]);

// Horizon result codes eligible for fee-bump retry
const FEE_ERROR_CODES = new Set([
  'tx_insufficient_fee',
  'tx_bad_min_seq_age_or_gap',
]);

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Extract the top-level result code from a Horizon SubmitTransactionResponse
 * error (HorizonError).
 */
function extractResultCode(err) {
  try {
    const extras = err?.response?.data?.extras;
    return extras?.result_codes?.transaction || null;
  } catch {
    return null;
  }
}

/**
 * Estimate the recommended fee from Horizon's /fee_stats endpoint.
 * Falls back to a sane default on any error.
 */
async function getRecommendedFee(multiplier = DEFAULT_FEE_MULTIPLIER) {
  try {
    const stats = await withStellarRetry(() => server.feeStats(), {
      label: 'feeStats',
    });
    // p80 is a reasonable ceiling that isn't too aggressive
    const p80 = parseInt(stats.fee_charged?.p80 || stats.max_fee?.p80 || DEFAULT_BASE_FEE_STROOPS, 10);
    return Math.ceil(p80 * multiplier);
  } catch (err) {
    logger.warn('Could not fetch fee_stats, using default base fee', { error: err.message });
    return Math.ceil(DEFAULT_BASE_FEE_STROOPS * multiplier);
  }
}

// ── Class ─────────────────────────────────────────────────────────────────────

class StellarTransactionManager {
  /**
   * @param {object} opts
   * @param {import('@stellar/stellar-sdk').Keypair} opts.signingKeypair
   *   Keypair that will sign submitted transactions (the source account).
   * @param {import('@stellar/stellar-sdk').Keypair} [opts.feeSourceKeypair]
   *   Optional separate keypair used as the fee-bump source.
   *   If omitted, signingKeypair is reused as the fee source.
   * @param {number} [opts.timeoutSeconds]   Override default tx timeout.
   * @param {number} [opts.feeMultiplier]    Override default fee multiplier.
   */
  constructor({ signingKeypair, feeSourceKeypair, timeoutSeconds, feeMultiplier } = {}) {
    if (!signingKeypair) {
      throw new Error('[StellarTxManager] signingKeypair is required');
    }
    this.signingKeypair = signingKeypair;
    this.feeSourceKeypair = feeSourceKeypair || signingKeypair;
    this.timeoutSeconds = timeoutSeconds || DEFAULT_TX_TIMEOUT_SECONDS;
    this.feeMultiplier = feeMultiplier || DEFAULT_FEE_MULTIPLIER;
  }

  /**
   * Load the current sequence number for an account directly from Horizon.
   * Always fetches fresh to avoid using a cached / stale sequence.
   *
   * @param {string} publicKey
   * @returns {Promise<import('@stellar/stellar-sdk').AccountResponse>}
   */
  async _loadAccount(publicKey) {
    return withStellarRetry(() => server.loadAccount(publicKey), {
      label: 'loadAccount',
    });
  }

  /**
   * Build a TransactionBuilder pre-loaded with:
   *  - fresh sequence number
   *  - dynamic fee from Horizon /fee_stats
   *  - timebounds [now, now + timeoutSeconds]
   *
   * @param {string} sourcePublicKey
   * @param {object} [opts]
   * @param {number} [opts.feeMultiplier]
   * @param {number} [opts.timeoutSeconds]
   * @returns {Promise<TransactionBuilder>}
   */
  async buildTransactionBuilder(sourcePublicKey, opts = {}) {
    const [account, fee] = await Promise.all([
      this._loadAccount(sourcePublicKey),
      getRecommendedFee(opts.feeMultiplier || this.feeMultiplier),
    ]);

    return new TransactionBuilder(account, {
      fee: String(fee),
      networkPassphrase,
    }).setTimeout(opts.timeoutSeconds || this.timeoutSeconds);
  }

  /**
   * Build, sign, and submit a transaction.
   *
   * Automatically handles tx_bad_seq by re-fetching the account sequence and
   * retrying once (covers the common race condition where sequence was
   * incremented by a parallel operation).
   *
   * @param {Function} addOperations
   *   Called with the TransactionBuilder; add your operations here.
   *   Signature: (builder: TransactionBuilder) => void
   * @param {object} [opts]
   * @param {string} [opts.memo]          Optional text memo (≤28 chars).
   * @param {number} [opts.feeMultiplier] Per-call fee multiplier override.
   * @param {number} [opts.timeoutSeconds] Per-call timeout override.
   * @returns {Promise<{ hash: string, ledger: number, envelope: string }>}
   */
  async buildAndSubmit(addOperations, opts = {}) {
    const sourcePublicKey = this.signingKeypair.publicKey();
    const attempt = async () => {
      const builder = await this.buildTransactionBuilder(sourcePublicKey, opts);
      addOperations(builder);
      if (opts.memo) builder.addMemo({ value: opts.memo, type: 'text' });
      const tx = builder.build();
      tx.sign(this.signingKeypair);
      return server.submitTransaction(tx);
    };

    let result;
    try {
      result = await withStellarRetry(attempt, { label: 'buildAndSubmit' });
    } catch (err) {
      const code = extractResultCode(err);

      // Retry once on stale sequence (sequence incremented between load & submit)
      if (SEQUENCE_ERROR_CODES.has(code)) {
        logger.warn('[StellarTxManager] tx_bad_seq — refreshing sequence and retrying once', {
          publicKey: sourcePublicKey,
          code,
        });
        try {
          result = await withStellarRetry(attempt, { label: 'buildAndSubmit.seqRetry' });
        } catch (retryErr) {
          logger.error('[StellarTxManager] Sequence retry failed', {
            code: extractResultCode(retryErr),
            error: retryErr.message,
          });
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    logger.info('[StellarTxManager] Transaction submitted', {
      hash: result.hash,
      ledger: result.ledger,
    });

    return {
      hash: result.hash,
      ledger: result.ledger,
      // XDR envelope for potential fee-bump use
      envelope: result.envelope_xdr,
    };
  }

  /**
   * Wrap an existing inner-transaction XDR envelope in a fee-bump transaction
   * and resubmit. Use this when the original transaction has insufficient fee
   * or is stuck in the pending pool.
   *
   * The fee-source account pays the bump fee. The inner transaction does NOT
   * need to be re-signed.
   *
   * @param {string} innerEnvelopeXdr
   *   XDR string of the original signed transaction (from buildAndSubmit result.envelope).
   * @param {object} [opts]
   * @param {number} [opts.feeMultiplier]
   *   Multiplier applied on top of the current p80 network fee.
   *   Capped at MAX_FEE_BUMP_MULTIPLIER. Default: 5.
   * @returns {Promise<{ hash: string, ledger: number }>}
   */
  async submitFeeBump(innerEnvelopeXdr, opts = {}) {
    const { FeeBumpTransaction, Transaction, TransactionBuilder: TB } = require('@stellar/stellar-sdk');

    const multiplier = Math.min(
      opts.feeMultiplier || 5,
      MAX_FEE_BUMP_MULTIPLIER,
    );
    const feeStoops = await getRecommendedFee(multiplier);

    const innerTx = new Transaction(innerEnvelopeXdr, networkPassphrase);

    const feeBumpTx = TB.buildFeeBump({
      feeSource: this.feeSourceKeypair,
      baseFee: String(feeStoops),
      innerTransaction: innerTx,
      networkPassphrase,
    });

    feeBumpTx.sign(this.feeSourceKeypair);

    logger.info('[StellarTxManager] Submitting fee-bump transaction', {
      innerHash: innerTx.hash().toString('hex'),
      feeStoops,
      multiplier,
      feeSource: this.feeSourceKeypair.publicKey(),
    });

    const result = await withStellarRetry(
      () => server.submitTransaction(feeBumpTx),
      { label: 'submitFeeBump' },
    );

    logger.info('[StellarTxManager] Fee-bump transaction submitted', {
      hash: result.hash,
      ledger: result.ledger,
    });

    return { hash: result.hash, ledger: result.ledger };
  }

  /**
   * Determine whether a submit error warrants a fee-bump retry.
   *
   * @param {Error} err  Error thrown by buildAndSubmit / submitTransaction.
   * @returns {boolean}
   */
  static isFeeBumpEligible(err) {
    const code = extractResultCode(err);
    if (code && FEE_ERROR_CODES.has(code)) return true;
    // Also flag when the error message suggests the tx timed out in the pool
    const msg = err?.message || '';
    return /tx_too_late|tx_insufficient_fee/i.test(msg);
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Build a StellarTransactionManager from raw secret key strings.
 * Prefer using signerKeyManager.getKeypair() to obtain the keypair.
 *
 * @param {string} signingSecret          Stellar secret key (S...)
 * @param {string} [feeSourceSecret]      Optional separate fee-source secret key
 * @returns {StellarTransactionManager}
 */
function createTransactionManager(signingSecret, feeSourceSecret) {
  const { Keypair } = require('@stellar/stellar-sdk');
  const signingKeypair = Keypair.fromSecret(signingSecret);
  const feeSourceKeypair = feeSourceSecret
    ? Keypair.fromSecret(feeSourceSecret)
    : undefined;
  return new StellarTransactionManager({ signingKeypair, feeSourceKeypair });
}

module.exports = {
  StellarTransactionManager,
  createTransactionManager,
  getRecommendedFee,
  extractResultCode,
};
