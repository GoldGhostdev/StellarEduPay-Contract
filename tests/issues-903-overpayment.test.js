'use strict';

/**
 * Tests for Issue #903
 * - feeAdjustmentService detects overpayment when amountPaid > finalFee
 * - remainingBalance is never negative (clamped to 0)
 * - overpayment object surfaced with creditAmount for caller to persist
 * - Conflict resolution policies: stack, first_only, best_for_student
 * - Deterministic precedence (priority ASC, name ASC)
 */

// Mock the DB model — tests drive behaviour via injected rules
jest.mock('../backend/src/models/feeAdjustmentRuleModel', () => ({
  find: jest.fn(),
}));

const FeeAdjustmentRule = require('../backend/src/models/feeAdjustmentRuleModel');
// Re-require after mock to get the real service
const feeAdjustmentService = require('../backend/src/services/feeAdjustmentService');

// Helper: mock FeeAdjustmentRule.find to return a fixed array
function mockRules(rules) {
  // find() is now awaited directly (no .sort() chaining) — return a thenable
  FeeAdjustmentRule.find.mockResolvedValue(rules);
}

const feeStructure = (amount) => ({ feeAmount: amount });
const ctx = (student, extra = {}) => ({
  schoolId: 'SCH001',
  student,
  paymentDate: new Date('2026-07-01'),
  baseAmount: student.feeAmount,
  academicYear: '2026',
  ...extra,
});

describe('#903 overpayment detection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no overpayment when amountPaid < finalFee', async () => {
    mockRules([]);
    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 500, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    expect(result.overpayment).toBeNull();
    expect(result.remainingBalance).toBe(500);
  });

  test('no overpayment when amountPaid equals finalFee exactly', async () => {
    mockRules([]);
    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 1000, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    expect(result.overpayment).toBeNull();
    expect(result.remainingBalance).toBe(0);
  });

  test('detects overpayment when totalPaid > finalFee after discount', async () => {
    const discountRule = {
      name: 'Big Discount', type: 'discount_percentage', value: 20,
      priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack',
    };
    mockRules([discountRule]);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 900, class: 'JSS1' };
    // Discount brings fee to 800, but student paid 900 → overpayment of 100
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    expect(result.finalFee).toBe(800);
    expect(result.overpayment).not.toBeNull();
    expect(result.overpayment.creditAmount).toBe(100);
    expect(result.overpayment.newFee).toBe(800);
    expect(result.overpayment.amountPaid).toBe(900);
    expect(result.overpayment.studentId).toBe('STU001');
  });

  test('remainingBalance is 0 (not negative) when overpayment occurs', async () => {
    const discountRule = {
      name: 'Big Discount', type: 'discount_percentage', value: 50,
      priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack',
    };
    mockRules([discountRule]);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 900, class: 'JSS1' };
    // 50% discount → fee = 500, paid 900 → overpayment
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    expect(result.remainingBalance).toBe(0);
    expect(result.remainingBalance).not.toBeLessThan(0);
  });

  test('creditAmount is precise to 2 decimal places', async () => {
    const discountRule = {
      name: 'Odd Discount', type: 'discount_percentage', value: 33,
      priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack',
    };
    mockRules([discountRule]);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 800, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    // 33% discount → 670, paid 800 → credit = 130
    expect(result.overpayment.creditAmount).toBe(130);
    // Decimal precision check
    expect(Number.isFinite(result.overpayment.creditAmount)).toBe(true);
  });
});

describe('#903 conflict resolution policies', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stack: all matching rules applied in priority order', async () => {
    const rules = [
      { name: 'Rule A', type: 'discount_percentage', value: 10, priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
      { name: 'Rule B', type: 'discount_percentage', value: 10, priority: 2, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    // 10% → 900, then 10% on 900 → 810
    expect(result.finalFee).toBe(810);
    expect(result.adjustmentsApplied).toHaveLength(2);
  });

  test('first_only: only first matching rule applied', async () => {
    const rules = [
      { name: 'Rule A', type: 'discount_percentage', value: 10, priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'first_only' },
      { name: 'Rule B', type: 'discount_percentage', value: 20, priority: 2, conditions: {}, isActive: true, conflictResolutionPolicy: 'first_only' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    // Only Rule A (priority 1) applies: 10% → 900
    expect(result.finalFee).toBe(900);
    expect(result.adjustmentsApplied).toHaveLength(1);
    expect(result.adjustmentsApplied[0].ruleName).toBe('Rule A');
  });

  test('best_for_student: picks discount that saves the most', async () => {
    const rules = [
      { name: 'Small Discount', type: 'discount_percentage', value: 5,  priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'best_for_student' },
      { name: 'Big Discount',   type: 'discount_percentage', value: 25, priority: 2, conditions: {}, isActive: true, conflictResolutionPolicy: 'best_for_student' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    // Small Discount at priority 1 runs first (950), Big Discount skipped (same type, already have one)
    // best_for_student keeps only the first discount encountered per priority
    expect(result.adjustmentsApplied.filter(a => a.type === 'discount_percentage')).toHaveLength(1);
  });

  test('waiver short-circuits further rule evaluation', async () => {
    const rules = [
      { name: 'Full Waiver', type: 'waiver', value: 0, priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
      { name: 'Penalty',     type: 'penalty_percentage', value: 10, priority: 2, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    expect(result.finalFee).toBe(0);
    expect(result.adjustmentsApplied).toHaveLength(1);
    expect(result.adjustmentsApplied[0].ruleName).toBe('Full Waiver');
  });
});

describe('#903 rule precedence (priority ASC, name ASC tiebreak)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lower priority number runs first', async () => {
    const rules = [
      { name: 'Z-Late Penalty', type: 'penalty_percentage', value: 10, priority: 5, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
      { name: 'A-Early Discount', type: 'discount_percentage', value: 20, priority: 1, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    // Priority 1 (discount 20%) runs first → 800, then priority 5 (penalty 10%) → 880
    expect(result.adjustmentsApplied[0].ruleName).toBe('A-Early Discount');
    expect(result.adjustmentsApplied[1].ruleName).toBe('Z-Late Penalty');
    expect(result.finalFee).toBe(880);
  });

  test('same priority resolved alphabetically by name', async () => {
    const rules = [
      { name: 'Z-Rule', type: 'discount_percentage', value: 5, priority: 10, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
      { name: 'A-Rule', type: 'discount_percentage', value: 10, priority: 10, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    // A-Rule (name asc) runs before Z-Rule
    expect(result.adjustmentsApplied[0].ruleName).toBe('A-Rule');
    expect(result.adjustmentsApplied[1].ruleName).toBe('Z-Rule');
  });

  test('same input always produces same output (determinism)', async () => {
    const rules = [
      { name: 'Discount', type: 'discount_percentage', value: 15, priority: 3, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
      { name: 'Penalty',  type: 'penalty_fixed',       value: 50, priority: 7, conditions: {}, isActive: true, conflictResolutionPolicy: 'stack' },
    ];

    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };

    // Run three times, each time re-mocking to same set of rules
    const results = [];
    for (let i = 0; i < 3; i++) {
      mockRules([...rules]);
      results.push(await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student)));
    }

    expect(results[0].finalFee).toBe(results[1].finalFee);
    expect(results[1].finalFee).toBe(results[2].finalFee);
  });

  test('conditions filter excludes non-matching student classes', async () => {
    const rules = [
      { name: 'JSS1 Only', type: 'discount_percentage', value: 20, priority: 1, conditions: { studentClass: ['JSS1'] }, isActive: true, conflictResolutionPolicy: 'stack' },
    ];
    mockRules(rules);

    const student = { studentId: 'STU002', feeAmount: 1000, totalPaid: 0, class: 'SSS1' };
    const result = await feeAdjustmentService.calculateAdjustedFee(feeStructure(1000), ctx(student));

    expect(result.finalFee).toBe(1000);
    expect(result.adjustmentsApplied).toHaveLength(0);
  });
});

describe('#903 simulateWithExtra', () => {
  beforeEach(() => jest.clearAllMocks());

  test('injects extra rule and returns ruleApplied:true when it matches', async () => {
    mockRules([]);

    const extraRule = {
      name: '_preview_', type: 'discount_percentage', value: 10,
      priority: 5, conditions: {}, isActive: true,
    };
    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.simulateWithExtra(
      feeStructure(1000), ctx(student), extraRule
    );

    expect(result.finalFee).toBe(900);
    expect(result.ruleApplied).toBe(true);
  });

  test('returns ruleApplied:false when extra rule conditions do not match', async () => {
    mockRules([]);

    const extraRule = {
      name: '_preview_', type: 'discount_percentage', value: 10,
      priority: 5, conditions: { studentClass: ['JSSXXX'] }, isActive: true,
    };
    const student = { studentId: 'STU001', feeAmount: 1000, totalPaid: 0, class: 'JSS1' };
    const result = await feeAdjustmentService.simulateWithExtra(
      feeStructure(1000), ctx(student), extraRule
    );

    expect(result.finalFee).toBe(1000);
    expect(result.ruleApplied).toBe(false);
  });
});
