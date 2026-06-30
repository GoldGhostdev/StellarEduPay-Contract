const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

/**
 * Fee Adjustment Rule
 *
 * Precedence semantics
 * -------------------
 * Rules are evaluated in ascending `priority` order — a **lower number means
 * higher priority** (priority 1 runs before priority 10).  When two rules share
 * the same priority value they are further sorted by `name` (ascending) so
 * the evaluation order is always fully deterministic.
 *
 * Conflict resolution policies
 * ----------------------------
 * When multiple rules match the same student/payment context the
 * `conflictResolutionPolicy` field controls how the engine handles them:
 *
 *   "stack"      (default) — all matching rules are applied in priority order,
 *                each one operating on the fee already modified by prior rules.
 *
 *   "first_only" — only the single highest-priority matching rule is applied;
 *                all subsequent matches are ignored.
 *
 *   "best_for_student" — among all matching discount rules the one that
 *                reduces the fee the most is selected; penalty rules are
 *                always stacked on top regardless.
 *
 * The policy stored on a rule acts as a *suggestion* for that rule's conflict
 * group.  When rules in the same priority band disagree the engine falls back
 * to "stack" to remain safe and predictable.
 */

const feeAdjustmentRuleSchema = new mongoose.Schema({
  schoolId: { type: String, required: true, index: true },
  name: { type: String, required: true }, // e.g., "Early Bird Discount", "Late Penalty"
  type: { 
    type: String, 
    enum: ['discount_percentage', 'discount_fixed', 'penalty_percentage', 'penalty_fixed', 'waiver'], 
    required: true 
  },
  value: { type: Number, required: true }, // e.g., 10 for 10%, 500 for ₦500
  conditions: {
    studentClass: [{ type: String }],           // e.g., ["JSS1", "JSS2"]
    academicYear: { type: String },
    paymentBefore: { type: Date },              // early bird
    paymentAfter: { type: Date },               // late penalty
    minAmount: { type: Number },
    maxAmount: { type: Number },
    // You can extend with more conditions (studentId list, grade, etc.)
  },
  isActive: { type: Boolean, default: true },
  /**
   * priority — lower value = higher precedence.
   * Rules with priority 1 are applied before rules with priority 10.
   * Rules sharing the same priority are applied in ascending `name` order.
   */
  priority: { type: Number, default: 10 },
  /**
   * conflictResolutionPolicy — what to do when multiple rules match.
   * See schema-level comment above for full semantics.
   */
  conflictResolutionPolicy: {
    type: String,
    enum: ['stack', 'first_only', 'best_for_student'],
    default: 'stack',
  },
  description: { type: String }
}, { timestamps: true });

feeAdjustmentRuleSchema.index({ schoolId: 1, name: 1 }, { unique: true });

feeAdjustmentRuleSchema.plugin(tenantScope, { modelName: 'FeeAdjustmentRule' });

module.exports = mongoose.model('FeeAdjustmentRule', feeAdjustmentRuleSchema);