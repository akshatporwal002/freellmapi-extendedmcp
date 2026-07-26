import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  delegateTaskSchema,
  executeDelegateTask,
  type DelegateTaskResult,
  type DelegationDependencies,
} from './delegation.js';
import {
  delegationQualityFloorSchema,
  evaluateModelQualityFloor,
} from './delegation-quality.js';

const profileQuerySchema = z.object({
  repository_id: z.string().min(1).max(200).optional(),
  category: z.enum([
    'implementation', 'bug_fix', 'debugging', 'testing', 'documentation',
    'review', 'refactoring', 'research', 'repository_analysis',
  ]).optional(),
  min_samples: z.number().int().min(1).max(1000).default(1),
}).strict();

export interface DelegationPerformanceProfile {
  repository_hash: string;
  category: string;
  provider: string;
  model: string;
  samples: number;
  accepted: number;
  revised: number;
  rejected: number;
  acceptance_rate: number;
  usable_rate: number;
  usable_rate_confidence_95: { low: number; high: number };
  regression_rate: number | null;
  avg_latency_ms: number;
  avg_output_tokens: number | null;
  avg_review_tokens: number | null;
  avg_edit_distance: number | null;
  trust_tier: 'suggest' | 'draft' | 'verified_draft' | 'routine_acceptance_candidate';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function wilson(successes: number, samples: number): { low: number; high: number } {
  if (samples <= 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = successes / samples;
  const denominator = 1 + z * z / samples;
  const center = (p + z * z / (2 * samples)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * samples)) / samples) / denominator;
  return { low: round(Math.max(0, center - margin)), high: round(Math.min(1, center + margin)) };
}

function meanConfidence95(values: number[]): { mean: number; low: number; high: number } | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  const studentTCritical95 = [
    Number.POSITIVE_INFINITY, 12.706, 4.303, 3.182, 2.776,
    2.571, 2.447, 2.365, 2.306, 2.262,
  ];
  const degreesOfFreedom = values.length - 1;
  const critical = degreesOfFreedom <= 10
    ? studentTCritical95[degreesOfFreedom]
    : degreesOfFreedom < 20 ? 2.201
    : degreesOfFreedom < 30 ? 2.045
    : 1.96;
  const margin = critical * standardError;
  return { mean: round(mean, 1), low: round(mean - margin, 1), high: round(mean + margin, 1) };
}

function trustTier(
  samples: number,
  accepted: number,
  usable: number,
  regressions: number,
): DelegationPerformanceProfile['trust_tier'] {
  const acceptedRate = samples > 0 ? accepted / samples : 0;
  const usableRate = samples > 0 ? usable / samples : 0;
  const regressionRate = samples > 0 ? regressions / samples : 1;
  if (samples >= 20 && acceptedRate >= 0.8 && regressions === 0) return 'routine_acceptance_candidate';
  if (samples >= 10 && usableRate >= 0.8 && regressionRate <= 0.05) return 'verified_draft';
  if (samples >= 5 && usableRate >= 0.5) return 'draft';
  return 'suggest';
}

export function getDelegationPerformanceProfiles(rawInput: unknown): {
  profiles: DelegationPerformanceProfile[];
  evidence_policy: { minimum_for_adaptive_routing: 5; confidence: 'wilson_95' };
} {
  const input = profileQuerySchema.parse(rawInput);
  const clauses = ['outcome IS NOT NULL', 'shadow_mode = 0', 'provider IS NOT NULL', 'model_id IS NOT NULL'];
  const params: unknown[] = [];
  if (input.repository_id) {
    clauses.push('repository_hash = ?');
    params.push(hash(input.repository_id));
  }
  if (input.category) {
    clauses.push('category = ?');
    params.push(input.category);
  }
  params.push(input.min_samples);
  const rows = getDb().prepare(`
    SELECT repository_hash, category, provider, model_id,
           COUNT(*) AS samples,
           SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN outcome = 'revised' THEN 1 ELSE 0 END) AS revised,
           SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN regression = 1 THEN 1 ELSE 0 END) AS regressions,
           SUM(CASE WHEN regression IS NOT NULL THEN 1 ELSE 0 END) AS regression_samples,
           AVG(latency_ms) AS avg_latency_ms,
           AVG(output_tokens) AS avg_output_tokens,
           AVG(review_tokens) AS avg_review_tokens,
           AVG(edit_distance) AS avg_edit_distance
      FROM delegation_history
     WHERE ${clauses.join(' AND ')}
     GROUP BY repository_hash, category, provider, model_id
    HAVING COUNT(*) >= ?
     ORDER BY samples DESC, provider, model_id
  `).all(...params) as Array<{
    repository_hash: string; category: string; provider: string; model_id: string;
    samples: number; accepted: number; revised: number; rejected: number;
    regressions: number; regression_samples: number; avg_latency_ms: number;
    avg_output_tokens: number | null; avg_review_tokens: number | null; avg_edit_distance: number | null;
  }>;
  return {
    profiles: rows.map(row => {
      const usable = row.accepted + row.revised;
      return {
        repository_hash: row.repository_hash,
        category: row.category,
        provider: row.provider,
        model: row.model_id,
        samples: row.samples,
        accepted: row.accepted,
        revised: row.revised,
        rejected: row.rejected,
        acceptance_rate: round(row.accepted / row.samples),
        usable_rate: round(usable / row.samples),
        usable_rate_confidence_95: wilson(usable, row.samples),
        regression_rate: row.regression_samples > 0 ? round(row.regressions / row.regression_samples) : null,
        avg_latency_ms: round(row.avg_latency_ms, 1),
        avg_output_tokens: row.avg_output_tokens == null ? null : round(row.avg_output_tokens, 1),
        avg_review_tokens: row.avg_review_tokens == null ? null : round(row.avg_review_tokens, 1),
        avg_edit_distance: row.avg_edit_distance == null ? null : round(row.avg_edit_distance, 1),
        trust_tier: trustTier(row.samples, row.accepted, usable, row.regressions),
      };
    }),
    evidence_policy: { minimum_for_adaptive_routing: 5, confidence: 'wilson_95' },
  };
}

const counterfactualSchema = profileQuerySchema.extend({
  repository_id: z.string().min(1).max(200),
  category: z.enum([
    'implementation', 'bug_fix', 'debugging', 'testing', 'documentation',
    'review', 'refactoring', 'research', 'repository_analysis',
  ]),
  current_provider: z.string().min(1).max(100),
  current_model: z.string().min(1).max(300),
  exploration_budget: z.number().int().min(0).max(3).default(1),
  min_samples: z.number().int().min(5).max(1000).default(5),
});

export function evaluateDelegationCounterfactual(rawInput: unknown) {
  const input = counterfactualSchema.parse(rawInput);
  const profiles = getDelegationPerformanceProfiles({
    repository_id: input.repository_id,
    category: input.category,
    min_samples: input.min_samples,
  }).profiles
    .filter(profile => profile.provider !== input.current_provider || profile.model !== input.current_model)
    .sort((a, b) =>
      b.usable_rate_confidence_95.low - a.usable_rate_confidence_95.low ||
      (a.regression_rate ?? 1) - (b.regression_rate ?? 1) ||
      a.avg_latency_ms - b.avg_latency_ms,
    );
  return {
    exploration_budget: input.exploration_budget,
    eligible_alternatives: profiles.length,
    shadow_candidates: profiles.slice(0, input.exploration_budget).map(profile => ({
      provider: profile.provider,
      model: profile.model,
      samples: profile.samples,
      usable_rate_confidence_95: profile.usable_rate_confidence_95,
      regression_rate: profile.regression_rate,
      execution_policy: 'shadow_only' as const,
    })),
    insufficient_evidence: profiles.length === 0,
  };
}

const decompositionSchema = z.object({
  objective: z.string().min(1).max(10_000),
  category: z.string().min(1).max(100),
  size: z.enum(['small', 'medium', 'large']),
  risk: z.enum(['low', 'medium', 'high']),
  permitted_files: z.array(z.string().min(1).max(500)).max(100).default([]),
  logical_scopes: z.array(z.string().min(1).max(500)).max(100).default([]),
  estimated_tokens: z.number().int().min(1).max(1_000_000).optional(),
}).strict();

export function recommendDelegationDecomposition(rawInput: unknown) {
  const input = decompositionSchema.parse(rawInput);
  const reasons: string[] = [];
  if (input.size === 'large') reasons.push('task size is large');
  if (input.risk === 'high') reasons.push('task risk is high');
  if (input.permitted_files.length > 5) reasons.push('task spans more than five files');
  if ((input.estimated_tokens ?? 0) > 32_000) reasons.push('estimated context exceeds 32k tokens');
  const required = reasons.length > 0;
  const boundaries = input.permitted_files.slice(0, 8).map((file, index) => ({
    id: `slice_${index + 1}`,
    owns_files: [file],
    dependency_hint: index === 0 ? [] : ['contract_or_implementation_slice'],
  }));
  return {
    decomposition_recommended: required,
    reasons,
    suggested_boundaries: required ? boundaries : [],
    codex_decision_required: required,
    note: required
      ? 'These are mechanical ownership boundaries, not architectural decisions; Codex must define each job contract.'
      : 'The task appears bounded enough for direct delegation under current heuristics.',
  };
}

const qualityFloorEvaluationSchema = z.object({
  repository_id: z.string().min(1).max(200),
  category: z.enum([
    'implementation', 'bug_fix', 'debugging', 'testing', 'documentation',
    'review', 'refactoring', 'research', 'repository_analysis',
  ]),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(300),
  policy: delegationQualityFloorSchema,
}).strict();

export function evaluateDelegationQualityFloor(rawInput: unknown) {
  const input = qualityFloorEvaluationSchema.parse(rawInput);
  return evaluateModelQualityFloor(input);
}

const savingsEstimateSchema = z.object({
  repository_id: z.string().min(1).max(200),
  category: z.enum([
    'implementation', 'bug_fix', 'debugging', 'testing', 'documentation',
    'review', 'refactoring', 'research', 'repository_analysis',
  ]),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(300),
  estimated_direct_codex_tokens: z.number().int().min(1).max(10_000_000),
  current_planning_tokens: z.number().int().min(0).max(10_000_000).default(0),
  min_samples: z.number().int().min(2).max(1000).default(5),
}).strict();

export function estimateDelegationSavings(rawInput: unknown) {
  const input = savingsEstimateSchema.parse(rawInput);
  const rows = getDb().prepare(`
    SELECT prompt_tokens, output_tokens, review_tokens
      FROM delegation_history
     WHERE repository_hash = ?
       AND category = ?
       AND provider = ?
       AND model_id = ?
       AND outcome IS NOT NULL
       AND shadow_mode = 0
       AND prompt_tokens IS NOT NULL
       AND output_tokens IS NOT NULL
       AND review_tokens IS NOT NULL
     ORDER BY created_at, task_id
  `).all(
    hash(input.repository_id),
    input.category,
    input.provider,
    input.model,
  ) as Array<{ prompt_tokens: number; output_tokens: number; review_tokens: number }>;

  if (rows.length < input.min_samples) {
    return {
      status: 'insufficient_evidence' as const,
      samples: rows.length,
      required_samples: input.min_samples,
      estimate: null,
      missing_evidence: 'reviewed non-shadow executions with complete worker and review token usage',
    };
  }
  const workerTokens = rows.map(row => row.prompt_tokens + row.output_tokens);
  const reviewTokens = rows.map(row => row.review_tokens);
  const premiumSavings = reviewTokens.map(tokens =>
    input.estimated_direct_codex_tokens - input.current_planning_tokens - tokens,
  );
  return {
    status: 'estimated' as const,
    samples: rows.length,
    required_samples: input.min_samples,
    estimate: {
      premium_token_savings_confidence_95: meanConfidence95(premiumSavings),
      worker_token_usage_confidence_95: meanConfidence95(workerTokens),
      codex_review_token_confidence_95: meanConfidence95(reviewTokens),
      assumptions: {
        estimated_direct_codex_tokens: input.estimated_direct_codex_tokens,
        current_planning_tokens: input.current_planning_tokens,
        rewrite_tokens_included_only_when_reported_as_review_tokens: true,
      },
      confidence: rows.length >= 30 ? 'high' as const : rows.length >= 10 ? 'moderate' as const : 'low' as const,
    },
    warning: 'This is a historical mean interval, not a guarantee; unreported rewrite or verification effort is excluded.',
  };
}

export async function executeDelegationCapabilityCanary(
  rawInput: unknown,
  dependencies?: DelegationDependencies,
): Promise<{
  passed: boolean;
  execution_policy: 'shadow_only';
  result: DelegateTaskResult;
}> {
  const input = delegateTaskSchema.parse(rawInput);
  const result = await executeDelegateTask({
    ...input,
    shadow_mode: true,
    max_attempts: 1,
    risk: 'low',
  }, dependencies);
  return {
    passed: result.status === 'completed' && result.quality_gate !== 'rejected',
    execution_policy: 'shadow_only',
    result,
  };
}
