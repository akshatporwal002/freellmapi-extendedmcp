import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const delegationQualityFloorSchema = z.object({
  min_samples: z.number().int().min(1).max(1000).default(5),
  min_usable_rate_lower_bound: z.number().min(0).max(1).default(0.5),
  max_regression_rate_upper_bound: z.number().min(0).max(1).default(0.3),
}).strict();

export type DelegationQualityFloor = z.infer<typeof delegationQualityFloorSchema>;

export interface DelegationQualityFloorDecision {
  allowed: boolean;
  reason: 'satisfied' | 'insufficient_evidence' | 'usable_rate_below_floor' | 'regression_rate_above_floor';
  samples: number;
  regression_samples: number;
  usable_rate_confidence_95: { low: number; high: number };
  regression_rate_confidence_95: { low: number; high: number };
  policy: DelegationQualityFloor;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function wilsonConfidence95(successes: number, samples: number): { low: number; high: number } {
  if (samples <= 0) return { low: 0, high: 1 };
  const zScore = 1.96;
  const proportion = successes / samples;
  const denominator = 1 + zScore * zScore / samples;
  const center = (proportion + zScore * zScore / (2 * samples)) / denominator;
  const margin = zScore
    * Math.sqrt((proportion * (1 - proportion) + zScore * zScore / (4 * samples)) / samples)
    / denominator;
  return {
    low: round(Math.max(0, center - margin)),
    high: round(Math.min(1, center + margin)),
  };
}

export function evaluateModelQualityFloor(input: {
  repository_id: string;
  category: string;
  provider: string;
  model: string;
  policy: unknown;
}): DelegationQualityFloorDecision {
  const policy = delegationQualityFloorSchema.parse(input.policy);
  const row = getDb().prepare(`
    SELECT COUNT(*) AS samples,
           SUM(CASE WHEN outcome IN ('accepted', 'revised') THEN 1 ELSE 0 END) AS usable,
           SUM(CASE WHEN regression IS NOT NULL THEN 1 ELSE 0 END) AS regression_samples,
           SUM(CASE WHEN regression = 1 THEN 1 ELSE 0 END) AS regressions
      FROM delegation_history
     WHERE repository_hash = ?
       AND category = ?
       AND provider = ?
       AND model_id = ?
       AND outcome IS NOT NULL
       AND shadow_mode = 0
  `).get(
    createHash('sha256').update(input.repository_id).digest('hex'),
    input.category,
    input.provider,
    input.model,
  ) as { samples: number; usable: number; regression_samples: number; regressions: number };

  const usableInterval = wilsonConfidence95(row.usable, row.samples);
  const regressionInterval = wilsonConfidence95(row.regressions, row.regression_samples);
  let reason: DelegationQualityFloorDecision['reason'] = 'satisfied';
  if (row.samples < policy.min_samples || row.regression_samples < policy.min_samples) {
    reason = 'insufficient_evidence';
  } else if (usableInterval.low < policy.min_usable_rate_lower_bound) {
    reason = 'usable_rate_below_floor';
  } else if (regressionInterval.high > policy.max_regression_rate_upper_bound) {
    reason = 'regression_rate_above_floor';
  }
  return {
    allowed: reason === 'satisfied',
    reason,
    samples: row.samples,
    regression_samples: row.regression_samples,
    usable_rate_confidence_95: usableInterval,
    regression_rate_confidence_95: regressionInterval,
    policy,
  };
}
