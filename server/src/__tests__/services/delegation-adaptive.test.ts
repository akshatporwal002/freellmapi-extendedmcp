import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BaseProvider } from '../../providers/base.js';
import {
  estimateDelegationSavings,
  evaluateDelegationCounterfactual,
  evaluateDelegationQualityFloor,
  executeDelegationCapabilityCanary,
  getDelegationPerformanceProfiles,
  recommendDelegationDecomposition,
} from '../../services/delegation-adaptive.js';
import {
  executeDelegateTask,
  type DelegationDependencies,
} from '../../services/delegation.js';
import type { RouteResult } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { runFallbackLoop } from '../../lib/fallback-loop.js';

function seedHistory(
  repositoryHash: string,
  provider: string,
  model: string,
  outcomes: Array<'accepted' | 'revised' | 'rejected'>,
) {
  const insert = getDb().prepare(`
    INSERT INTO delegation_history (
      task_id, repository_hash, category, size, risk, selection_mode,
      model_id, provider, status, quality_gate, prompt_tokens, output_tokens,
      latency_ms, context_receipt_hash, schema_version, prompt_version,
      policy_version, outcome, edit_distance, regression, review_tokens
    ) VALUES (?, ?, 'implementation', 'small', 'low', 'adaptive',
      ?, ?, 'completed', 'pass', 100, 50, 20, 'receipt', '1', '1', '1',
      ?, ?, ?, 30)
  `);
  outcomes.forEach((outcome, index) => insert.run(
    `${provider}-${model}-${index}`,
    repositoryHash,
    model,
    provider,
    outcome,
    outcome === 'accepted' ? 0 : 5,
    outcome === 'rejected' ? 1 : 0,
  ));
}

describe('adaptive delegation evidence', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const repositoryHash = createHash('sha256').update('adaptive-profile-repo').digest('hex');
    getDb().prepare(`
      INSERT OR IGNORE INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label
      ) VALUES (?, ?, ?, 1, 1, 'Small')
    `).run('provider-a', 'model-a', 'Model A');
    getDb().prepare(`
      INSERT OR IGNORE INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label
      ) VALUES (?, ?, ?, 2, 2, 'Medium')
    `).run('provider-b', 'model-b', 'Model B');
    seedHistory(repositoryHash, 'provider-a', 'model-a', Array(10).fill('accepted'));
    seedHistory(repositoryHash, 'provider-b', 'model-b', [
      'accepted', 'accepted', 'accepted', 'revised', 'revised',
      'rejected', 'rejected', 'rejected', 'rejected', 'rejected',
    ]);
    getDb().prepare(`
      UPDATE delegation_history
         SET regression_attribution = 'probable',
             regression_confidence = 0.4
       WHERE task_id = 'provider-b-model-b-5'
    `).run();
  });

  it('returns confidence-bounded profiles and progressive trust from reviewed outcomes', () => {
    const result = getDelegationPerformanceProfiles({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      min_samples: 5,
    });
    expect(result.evidence_policy).toEqual({
      minimum_for_adaptive_routing: 5,
      confidence: 'wilson_95',
    });
    expect(result.profiles).toHaveLength(2);
    const strong = result.profiles.find(profile => profile.model === 'model-a')!;
    expect(strong.samples).toBe(10);
    expect(strong.acceptance_rate).toBe(1);
    expect(strong.usable_rate_confidence_95.low).toBeGreaterThan(0.7);
    expect(strong.trust_tier).toBe('verified_draft');
    const weak = result.profiles.find(profile => profile.model === 'model-b')!;
    expect(weak.regression_rate).toBe(0.5);
    expect(weak.confidence_weighted_regression_rate).toBe(0.44);
    expect(weak.trust_tier).toBe('draft');
    expect(strong.catalogue_available).toBe(true);
  });

  it('enforces a strict counterfactual exploration budget and shadow-only policy', () => {
    const result = evaluateDelegationCounterfactual({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      current_provider: 'provider-b',
      current_model: 'model-b',
      exploration_budget: 1,
    });
    expect(result.shadow_candidates).toHaveLength(1);
    expect(result.shadow_candidates[0]).toMatchObject({
      provider: 'provider-a',
      model: 'model-a',
      execution_policy: 'shadow_only',
    });
    expect(() => evaluateDelegationCounterfactual({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      current_provider: 'provider-b',
      current_model: 'model-b',
      exploration_budget: 4,
    })).toThrow();

    getDb().prepare(`
      UPDATE models SET enabled = 0
       WHERE platform = 'provider-a' AND model_id = 'model-a'
    `).run();
    const unavailable = evaluateDelegationCounterfactual({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      current_provider: 'provider-b',
      current_model: 'model-b',
      exploration_budget: 1,
    });
    expect(unavailable.shadow_candidates).toEqual([]);
    getDb().prepare(`
      UPDATE models SET enabled = 1
       WHERE platform = 'provider-a' AND model_id = 'model-a'
    `).run();
  });

  it('uses confidence bounds for quality floors and savings estimates', () => {
    const strong = evaluateDelegationQualityFloor({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      provider: 'provider-a',
      model: 'model-a',
      policy: {},
    });
    expect(strong).toMatchObject({ allowed: true, reason: 'satisfied', samples: 10 });

    const weak = evaluateDelegationQualityFloor({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      provider: 'provider-b',
      model: 'model-b',
      policy: {},
    });
    expect(weak.allowed).toBe(false);
    expect(weak.reason).not.toBe('satisfied');

    const savings = estimateDelegationSavings({
      repository_id: 'adaptive-profile-repo',
      category: 'implementation',
      provider: 'provider-a',
      model: 'model-a',
      estimated_direct_codex_tokens: 1000,
      current_planning_tokens: 100,
    });
    expect(savings.status).toBe('estimated');
    expect(savings.estimate?.premium_token_savings_confidence_95).toEqual({
      mean: 870,
      low: 870,
      high: 870,
    });
    expect(savings.estimate?.worker_token_usage_confidence_95.mean).toBe(150);

    expect(estimateDelegationSavings({
      repository_id: 'unknown',
      category: 'implementation',
      provider: 'provider-a',
      model: 'model-a',
      estimated_direct_codex_tokens: 1000,
    }).status).toBe('insufficient_evidence');
  });

  it('recommends decomposition without inventing architectural contracts', () => {
    const large = recommendDelegationDecomposition({
      objective: 'Change a broad feature',
      category: 'implementation',
      size: 'large',
      risk: 'high',
      permitted_files: ['a.ts', 'b.ts', 'c.ts'],
      estimated_tokens: 40_000,
    });
    expect(large.decomposition_recommended).toBe(true);
    expect(large.codex_decision_required).toBe(true);
    expect(large.suggested_boundaries).toHaveLength(3);
    expect(large.note).toContain('not architectural decisions');

    const small = recommendDelegationDecomposition({
      objective: 'Change one helper',
      category: 'implementation',
      size: 'small',
      risk: 'low',
      permitted_files: ['a.ts'],
    });
    expect(small.decomposition_recommended).toBe(false);
  });

  it('forces capability canaries into single-attempt shadow mode', async () => {
    let maxRetries: number | undefined;
    const provider = {
      chatCompletion: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              status: 'completed',
              candidate: 'Canary analysis.',
              confidence: 0.8,
            }),
          },
        }],
      }),
    } as unknown as BaseProvider;
    const route: RouteResult = {
      provider,
      modelId: 'canary-model',
      modelDbId: 1,
      apiKey: 'mock',
      keyId: 1,
      platform: 'mock',
      displayName: 'Canary',
      rpdLimit: null,
      tpdLimit: null,
    };
    const dependencies: DelegationDependencies = {
      route: () => route,
      recordSuccess: () => {},
      runFallback: async hooks => {
        maxRetries = hooks.maxRetries;
        await hooks.dispatch(hooks.route(0), 0);
      },
    };
    const canary = await executeDelegationCapabilityCanary({
      objective: 'Check analysis capability',
      category: 'repository_analysis',
      size: 'small',
      risk: 'medium',
      relevant_context: [{ label: 'sample', content: 'const x = 1;' }],
      acceptance_criteria: ['Return analysis'],
      output_mode: 'analysis',
    }, dependencies);
    expect(maxRetries).toBe(1);
    expect(canary.execution_policy).toBe('shadow_only');
    expect(canary.result.shadow_mode).toBe(true);
    expect(canary.passed).toBe(true);
  });

  it('skips a route below an explicit quality floor before inference', async () => {
    let providerCalls = 0;
    const provider = {
      chatCompletion: async () => {
        providerCalls++;
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                status: 'completed',
                candidate: 'Bounded analysis.',
                confidence: 0.9,
              }),
            },
          }],
        };
      },
    } as unknown as BaseProvider;
    const routeFor = (platform: string, modelId: string, modelDbId: number): RouteResult => ({
      provider,
      modelId,
      modelDbId,
      apiKey: 'mock',
      keyId: modelDbId,
      platform,
      displayName: modelId,
      rpdLimit: null,
      tpdLimit: null,
    });
    const dependencies: DelegationDependencies = {
      route: (_tokens, _skipKeys, skipModels) =>
        skipModels?.has(2)
          ? routeFor('provider-a', 'model-a', 1)
          : routeFor('provider-b', 'model-b', 2),
      recordSuccess: () => {},
      runFallback: runFallbackLoop,
    };
    const result = await executeDelegateTask({
      objective: 'Check bounded analysis',
      category: 'implementation',
      size: 'small',
      risk: 'low',
      relevant_context: [{ label: 'sample', content: 'const x = 1;' }],
      acceptance_criteria: ['Return analysis'],
      output_mode: 'analysis',
      repository_id: 'adaptive-profile-repo',
      max_attempts: 2,
      quality_floor: {},
    }, dependencies);
    expect(providerCalls).toBe(1);
    expect(result.selected_model).toBe('model-a');
    expect(result.attempts[0].error_class).toBe('quality_floor');
    expect(result.quality_floor?.allowed).toBe(true);
  });
});
