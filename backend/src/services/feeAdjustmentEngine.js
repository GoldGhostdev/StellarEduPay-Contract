'use strict';

const logger = require('../utils/logger');

/**
 * Dynamic Fee Adjustment Engine
 * 
 * Handles flexible discounts, penalties, and promotions for StellarEduPay payments.
 * This engine is used during payment validation to calculate the final fee.
 */

class DynamicFeeAdjustmentEngine {
  constructor() {
    this.rules = [];
    this.loadDefaultRules();
  }

  /**
   * Load default fee adjustment rules
   */
  loadDefaultRules() {
    this.rules = [
      {
        id: 'early-payment',
        name: 'Early Payment Discount',
        type: 'discount',
        condition: (ctx) => ctx.isEarly === true,
        value: 15,                    // 15% discount
        priority: 10,
        description: '15% discount for payments made at least 7 days in advance',
      },
      {
        id: 'student-discount',
        name: 'Student Discount',
        type: 'discount',
        condition: (ctx) => ctx.userType === 'student',
        value: 20,                    // 20% discount
        priority: 8,
        description: '20% discount for verified students',
      },
      {
        id: 'late-penalty',
        name: 'Late Payment Penalty',
        type: 'penalty',
        condition: (ctx) => ctx.isLate === true,
        value: 12,                    // 12% penalty
        priority: 15,
        description: '12% penalty for late payments',
      },
      {
        id: 'volume-discount',
        name: 'Volume Discount',
        type: 'discount',
        condition: (ctx) => ctx.totalPaymentsThisMonth >= 3,
        value: 10,                    // 10% discount
        priority: 12,
        description: '10% discount for 3 or more payments in a month',
      },
      {
        id: 'promo-edu2026',
        name: 'Promo Code Discount',
        type: 'discount',
        condition: (ctx) => ctx.promoCode && ctx.promoCode.toUpperCase() === 'EDU2026',
        value: 25,                    // 25% discount
        priority: 5,
        description: 'Special 25% discount with promo code EDU2026',
      },
    ];

    // Sort rules by priority (highest priority applied first)
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Add a new custom rule dynamically.
   * Validates required fields and rejects percentage discounts > 100.
   * @param {Object} rule
   */
  addRule(rule) {
    if (!rule || typeof rule !== 'object') throw new Error('rule must be an object');
    if (!rule.id || typeof rule.id !== 'string') throw new Error('rule.id is required');
    if (!rule.name || typeof rule.name !== 'string') throw new Error('rule.name is required');
    if (!['discount', 'penalty'].includes(rule.type)) throw new Error('rule.type must be "discount" or "penalty"');
    if (typeof rule.value !== 'number' || rule.value < 0) throw new Error('rule.value must be a non-negative number');
    if (typeof rule.condition !== 'function') throw new Error('rule.condition must be a function');
    const isFixed = rule.isFixed === true ||
      (typeof rule.description === 'string' && rule.description.toLowerCase().startsWith('fixed'));
    if (!isFixed && rule.type === 'discount' && rule.value > 100) {
      throw new Error('discount percentage rule.value cannot exceed 100');
    }
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Calculate final fee after applying all matching rules
   * @param {Object} context - Fee calculation context
   * @returns {Object} Fee calculation result
   */
  calculateFee(context) {
    let currentFee = Number(context.baseAmount || 0);
    const adjustments = [];

    for (const rule of this.rules) {
      if (rule.condition(context)) {
        let adjustmentAmount = 0;

        const isFixed = rule.isFixed === true ||
          (typeof rule.description === 'string' && rule.description.toLowerCase().startsWith('fixed'));
        if (rule.type === 'discount') {
          adjustmentAmount = isFixed ? -rule.value : -(currentFee * (rule.value / 100));
        } else if (rule.type === 'penalty') {
          adjustmentAmount = isFixed ? rule.value : currentFee * (rule.value / 100);
        } else {
          adjustmentAmount = rule.value; // fixed amount
        }

        currentFee += adjustmentAmount;

        adjustments.push({
          ruleName: rule.name,
          type: rule.type,
          value: rule.value,
          amountAdjusted: Math.abs(adjustmentAmount),
          finalFeeAfterRule: parseFloat(currentFee.toFixed(2)),
          reason: rule.description,
        });
      }
    }

    const finalFee = Math.max(0, currentFee); // Prevent negative fees

    if (currentFee < 0) {
      logger.warn({
        msg: 'Fee clamped to 0 after adjustments',
        studentId: context.studentId || null,
        unclampedAmount: parseFloat(currentFee.toFixed(2)),
      });
    }

    return {
      baseFee: context.baseAmount,
      finalFee: parseFloat(finalFee.toFixed(2)),
      adjustments,
      effectiveRate: context.baseAmount > 0 
        ? parseFloat(((finalFee / context.baseAmount) * 100).toFixed(2)) 
        : 100,
      totalAdjustments: adjustments.length,
    };
  }
}

// Export singleton instance
const feeEngine = new DynamicFeeAdjustmentEngine();

module.exports = {
  DynamicFeeAdjustmentEngine,
  feeEngine
};