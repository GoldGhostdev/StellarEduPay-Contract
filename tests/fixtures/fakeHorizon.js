'use strict';

/**
 * Fake Horizon server — a deterministic, offline stand-in for the subset of
 * the Stellar Horizon SDK surface that backend/src/services/stellarService.js
 * and backend/src/config/stellarConfig.js rely on:
 *
 *   server.transactions().transaction(hash).call()
 *   server.transactions().forAccount(address).order().limit().call()
 *   server.ledgers().order().limit().call()
 *   <tx>.operations()
 *
 * Tests `require()` this module directly to seed transactions/ledgers, and
 * jest.mock('.../config/stellarConfig') returns the same singleton's `server`
 * so the real (unmocked) controller/service code runs against fixture data
 * instead of the network — no HTTP, no flakiness, fully repeatable.
 */

let transactions = [];
let latestLedgerSeq = 1000;
let ledgerCounter = 1000;

function reset() {
  transactions = [];
  latestLedgerSeq = 1000;
  ledgerCounter = 1000;
}

/** Manually move the "tip" of the chain forward (e.g. to test pending_confirmation). */
function setLatestLedger(seq) {
  latestLedgerSeq = seq;
}

/**
 * Register a fake successful payment transaction.
 * Returns the stored transaction record.
 */
function addPaymentTransaction({
  hash,
  to,
  from,
  amount,
  assetCode = 'XLM',
  assetIssuer = null,
  memo,
  memoType = 'text',
  ledger,
  createdAt,
  successful = true,
  feePaid = '100',
}) {
  ledgerCounter += 1;
  const ledgerAttr = ledger ?? ledgerCounter;
  // Auto-confirm by default — keep the chain tip comfortably ahead so
  // CONFIRMATION_THRESHOLD-based checks pass unless a test opts out via setLatestLedger.
  if (ledgerAttr + 10 > latestLedgerSeq) latestLedgerSeq = ledgerAttr + 10;

  const tx = {
    hash,
    successful,
    memo_type: memoType,
    memo: memo ?? null,
    created_at: createdAt || new Date().toISOString(),
    ledger_attr: ledgerAttr,
    fee_paid: feePaid,
    operations: async () => ({
      records: [
        {
          type: 'payment',
          to,
          from,
          amount: String(amount),
          asset_type: assetCode === 'XLM' ? 'native' : 'credit_alphanum4',
          asset_code: assetCode === 'XLM' ? undefined : assetCode,
          asset_issuer: assetCode === 'XLM' ? undefined : assetIssuer,
        },
      ],
    }),
  };
  transactions.push(tx);
  return tx;
}

function findByHash(hash) {
  return transactions.find((t) => t.hash === hash);
}

function notFoundError() {
  return Object.assign(new Error('Resource Missing'), { response: { status: 404 } });
}

const server = {
  transactions() {
    return {
      transaction(hash) {
        return {
          async call() {
            const tx = findByHash(hash);
            if (!tx) throw notFoundError();
            return tx;
          },
        };
      },
      forAccount() {
        const chain = {
          order() {
            return chain;
          },
          limit() {
            return chain;
          },
          async call() {
            // Most-recent-first, mirroring order('desc') on real Horizon.
            return {
              records: transactions.slice().reverse(),
              async next() {
                return { records: [] };
              },
            };
          },
        };
        return chain;
      },
    };
  },
  ledgers() {
    const chain = {
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      async call() {
        return { records: [{ sequence: latestLedgerSeq }] };
      },
    };
    return chain;
  },
};

module.exports = { server, reset, setLatestLedger, addPaymentTransaction, findByHash };
