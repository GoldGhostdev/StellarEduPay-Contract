'use strict';

/**
 * Unit tests for the payment confirmation finality state machine (issue #747).
 *
 * Pure module — no DB/Horizon access — so these tests exercise the policy
 * directly: state computation from ledger depth, idempotent/monotonic
 * transitions (the "re-polling never advances a payment incorrectly"
 * acceptance criterion), and the legacy status mapping.
 */

const {
  CONFIRMATION_STATES,
  STATE_RANK,
  TERMINAL_STATES,
  CONFIRMATION_STATE_TRANSITIONS,
  computeTargetState,
  resolveNextState,
  deriveLegacyConfirmationStatus,
  isConfirmedOrAbove,
} = require('../src/services/paymentConfirmationStateMachine');

const CONFIRMATION_THRESHOLD = 2;
const FINALIZATION_THRESHOLD = 10;

describe('computeTargetState', () => {
  it('returns detected when ledger info is unknown', () => {
    expect(
      computeTargetState({
        txLedger: null,
        latestLedgerSequence: 100,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.DETECTED);

    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: null,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.DETECTED);
  });

  it('returns detected at depth 0 (tx ledger == latest ledger)', () => {
    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: 100,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.DETECTED);
  });

  it('returns pending once at least 1 ledger has closed but below the confirmation threshold', () => {
    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: 101,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.PENDING);
  });

  it('returns confirmed once depth meets the confirmation threshold', () => {
    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: 102,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.CONFIRMED);
  });

  it('returns finalized once depth meets the finalization threshold', () => {
    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: 110,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.FINALIZED);
  });

  it('can jump straight from unseen to confirmed/finalized when first observed deep in the chain', () => {
    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: 103,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.CONFIRMED);
  });

  it('returns failed whenever isSuspicious is true, regardless of depth', () => {
    expect(
      computeTargetState({
        txLedger: 100,
        latestLedgerSequence: 200,
        isSuspicious: true,
        confirmationThreshold: CONFIRMATION_THRESHOLD,
        finalizationThreshold: FINALIZATION_THRESHOLD,
      }),
    ).toBe(CONFIRMATION_STATES.FAILED);
  });
});

describe('resolveNextState — idempotency & monotonicity', () => {
  it('advances detected -> pending -> confirmed -> finalized in order', () => {
    expect(resolveNextState(CONFIRMATION_STATES.DETECTED, CONFIRMATION_STATES.PENDING))
      .toEqual({ state: CONFIRMATION_STATES.PENDING, changed: true });
    expect(resolveNextState(CONFIRMATION_STATES.PENDING, CONFIRMATION_STATES.CONFIRMED))
      .toEqual({ state: CONFIRMATION_STATES.CONFIRMED, changed: true });
    expect(resolveNextState(CONFIRMATION_STATES.CONFIRMED, CONFIRMATION_STATES.FINALIZED))
      .toEqual({ state: CONFIRMATION_STATES.FINALIZED, changed: true });
  });

  it('allows forward jumps that skip intermediate states', () => {
    expect(resolveNextState(CONFIRMATION_STATES.DETECTED, CONFIRMATION_STATES.CONFIRMED))
      .toEqual({ state: CONFIRMATION_STATES.CONFIRMED, changed: true });
    expect(resolveNextState(CONFIRMATION_STATES.DETECTED, CONFIRMATION_STATES.FINALIZED))
      .toEqual({ state: CONFIRMATION_STATES.FINALIZED, changed: true });
  });

  it('re-polling the same ledger range (same target) is a no-op', () => {
    expect(resolveNextState(CONFIRMATION_STATES.CONFIRMED, CONFIRMATION_STATES.CONFIRMED))
      .toEqual({ state: CONFIRMATION_STATES.CONFIRMED, changed: false });
    expect(resolveNextState(CONFIRMATION_STATES.PENDING, CONFIRMATION_STATES.PENDING))
      .toEqual({ state: CONFIRMATION_STATES.PENDING, changed: false });
  });

  it('never regresses when a recompute yields a lower-ranked target (e.g. stale/lagging Horizon replica)', () => {
    expect(resolveNextState(CONFIRMATION_STATES.CONFIRMED, CONFIRMATION_STATES.PENDING))
      .toEqual({ state: CONFIRMATION_STATES.CONFIRMED, changed: false });
    expect(resolveNextState(CONFIRMATION_STATES.FINALIZED, CONFIRMATION_STATES.CONFIRMED))
      .toEqual({ state: CONFIRMATION_STATES.FINALIZED, changed: false });
  });

  it('terminal states (finalized, failed) never move, even to a higher-ranked target', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(resolveNextState(terminal, CONFIRMATION_STATES.FINALIZED))
        .toEqual({ state: terminal, changed: false });
      expect(resolveNextState(terminal, CONFIRMATION_STATES.FAILED))
        .toEqual({ state: terminal, changed: false });
    }
  });

  it('failed is reachable from any non-terminal state', () => {
    for (const state of [
      CONFIRMATION_STATES.DETECTED,
      CONFIRMATION_STATES.PENDING,
      CONFIRMATION_STATES.CONFIRMED,
    ]) {
      expect(resolveNextState(state, CONFIRMATION_STATES.FAILED))
        .toEqual({ state: CONFIRMATION_STATES.FAILED, changed: true });
    }
  });

  it('treats a missing/unknown current state as detected', () => {
    expect(resolveNextState(null, CONFIRMATION_STATES.PENDING))
      .toEqual({ state: CONFIRMATION_STATES.PENDING, changed: true });
    expect(resolveNextState(undefined, CONFIRMATION_STATES.PENDING))
      .toEqual({ state: CONFIRMATION_STATES.PENDING, changed: true });
    expect(resolveNextState('not-a-real-state', CONFIRMATION_STATES.PENDING))
      .toEqual({ state: CONFIRMATION_STATES.PENDING, changed: true });
  });

  it('throws on an unknown target state', () => {
    expect(() => resolveNextState(CONFIRMATION_STATES.DETECTED, 'bogus')).toThrow(
      /Unknown confirmation state/,
    );
  });

  it('repeated application of the same target is stable (full idempotency check)', () => {
    let current = CONFIRMATION_STATES.DETECTED;
    const target = CONFIRMATION_STATES.CONFIRMED;

    const first = resolveNextState(current, target);
    current = first.state;
    expect(first.changed).toBe(true);

    // Re-running with the same target after the state has already advanced
    // must not change anything — this is the "re-poll the same range" case.
    for (let i = 0; i < 5; i++) {
      const next = resolveNextState(current, target);
      expect(next).toEqual({ state: CONFIRMATION_STATES.CONFIRMED, changed: false });
      current = next.state;
    }
  });
});

describe('CONFIRMATION_STATE_TRANSITIONS / STATE_RANK consistency', () => {
  it('only documents forward (higher-ranked) transitions', () => {
    for (const [from, tos] of Object.entries(CONFIRMATION_STATE_TRANSITIONS)) {
      for (const to of tos) {
        expect(STATE_RANK[to]).toBeGreaterThan(STATE_RANK[from]);
      }
    }
  });

  it('has no outgoing transitions from terminal states', () => {
    expect(CONFIRMATION_STATE_TRANSITIONS[CONFIRMATION_STATES.FINALIZED]).toEqual([]);
    expect(CONFIRMATION_STATE_TRANSITIONS[CONFIRMATION_STATES.FAILED]).toEqual([]);
  });
});

describe('deriveLegacyConfirmationStatus', () => {
  it('maps detected/pending to pending_confirmation', () => {
    expect(deriveLegacyConfirmationStatus(CONFIRMATION_STATES.DETECTED)).toBe('pending_confirmation');
    expect(deriveLegacyConfirmationStatus(CONFIRMATION_STATES.PENDING)).toBe('pending_confirmation');
  });

  it('maps confirmed/finalized to confirmed', () => {
    expect(deriveLegacyConfirmationStatus(CONFIRMATION_STATES.CONFIRMED)).toBe('confirmed');
    expect(deriveLegacyConfirmationStatus(CONFIRMATION_STATES.FINALIZED)).toBe('confirmed');
  });

  it('maps failed to failed', () => {
    expect(deriveLegacyConfirmationStatus(CONFIRMATION_STATES.FAILED)).toBe('failed');
  });
});

describe('isConfirmedOrAbove', () => {
  it('is false for detected/pending', () => {
    expect(isConfirmedOrAbove(CONFIRMATION_STATES.DETECTED)).toBe(false);
    expect(isConfirmedOrAbove(CONFIRMATION_STATES.PENDING)).toBe(false);
  });

  it('is true for confirmed/finalized', () => {
    expect(isConfirmedOrAbove(CONFIRMATION_STATES.CONFIRMED)).toBe(true);
    expect(isConfirmedOrAbove(CONFIRMATION_STATES.FINALIZED)).toBe(true);
  });
});
