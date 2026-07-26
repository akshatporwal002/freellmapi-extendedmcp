import { describe, expect, it } from 'vitest';
import {
  executeDelegationGraph,
  planDelegationGraph,
  type DelegationGraphDependencies,
} from '../../services/delegation-graph.js';
import type { DelegateTaskResult } from '../../services/delegation.js';

function task(objective: string, permittedFile: string) {
  return {
    objective,
    category: 'implementation',
    size: 'small',
    risk: 'low',
    relevant_context: [{ path: permittedFile, content: 'export const value = 1;' }],
    permitted_files: [permittedFile],
    acceptance_criteria: ['Return a minimal patch'],
    output_mode: 'patch',
  };
}

function completed(id: string, qualityGate: DelegateTaskResult['quality_gate'] = 'pass'): DelegateTaskResult {
  return {
    task_id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    status: 'completed',
    output_mode: 'patch',
    candidate: 'diff --git a/a.ts b/a.ts',
    confidence: 0.8,
    abstention: null,
    selection_mode: 'task_aware',
    selected_model: `model-${id}`,
    selected_provider: 'mock',
    usage: { input_tokens: 10, output_tokens: 10, estimated: false },
    attempts: [],
    validation_warnings: [],
    shadow_mode: false,
    review_mode: 'none',
    quality_gate: qualityGate,
    patch_assessment: null,
    codex_review_required: true,
    versions: { schema: '1', prompt: '1', policy: '1' },
    context_receipt: { entries: [] },
  };
}

describe('delegation job graphs', () => {
  it('produces deterministic dependency levels and replay hashes', () => {
    const graph = {
      feature_brief: 'Implement feature X',
      jobs: [
        { id: 'implementation', task: task('implement', 'src/a.ts'), owns_files: ['src/a.ts'] },
        { id: 'tests', depends_on: ['implementation'], task: task('test', 'src/a.test.ts'), owns_files: ['src/a.test.ts'] },
        { id: 'docs', depends_on: ['implementation'], task: task('document', 'docs/a.md'), owns_files: ['docs/a.md'] },
      ],
    };
    const first = planDelegationGraph(graph);
    const second = planDelegationGraph(graph);
    expect(first.levels).toEqual([['implementation'], ['docs', 'tests']]);
    expect(first.deterministic_order).toEqual(['implementation', 'docs', 'tests']);
    expect(first.graph_hash).toBe(second.graph_hash);
    expect(first.context_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects cycles, unknown dependencies, and unsafe parallel ownership', () => {
    expect(() => planDelegationGraph({
      jobs: [
        { id: 'a', depends_on: ['b'], task: task('a', 'a.ts') },
        { id: 'b', depends_on: ['a'], task: task('b', 'b.ts') },
      ],
    })).toThrow('dependency cycle');
    expect(() => planDelegationGraph({
      jobs: [{ id: 'a', depends_on: ['missing'], task: task('a', 'a.ts') }],
    })).toThrow('unknown job');
    expect(() => planDelegationGraph({
      jobs: [
        { id: 'a', owns_files: ['src/shared.ts'], task: task('a', 'src/shared.ts') },
        { id: 'b', owns_files: ['src/shared.ts'], task: task('b', 'src/shared.ts') },
      ],
    })).toThrow('parallel ownership conflict');
  });

  it('allows the same ownership when an explicit dependency serializes jobs', () => {
    expect(() => planDelegationGraph({
      jobs: [
        { id: 'a', owns_logical_scopes: ['public-api'], task: task('a', 'src/a.ts') },
        { id: 'b', depends_on: ['a'], owns_logical_scopes: ['public-api'], task: task('b', 'src/a.ts') },
      ],
    })).not.toThrow();
  });

  it('executes ready jobs concurrently up to the bound and preserves deterministic output order', async () => {
    let active = 0;
    let maxActive = 0;
    const dependencies: DelegationGraphDependencies = {
      executeTask: async input => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return completed(input.objective);
      },
    };
    const result = await executeDelegationGraph({
      jobs: [
        { id: 'a', task: task('1', 'a.ts'), owns_files: ['a.ts'] },
        { id: 'b', task: task('2', 'b.ts'), owns_files: ['b.ts'] },
        { id: 'c', task: task('3', 'c.ts'), owns_files: ['c.ts'] },
      ],
      max_parallel: 2,
    }, dependencies);
    expect(maxActive).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.jobs.map(job => job.id)).toEqual(['a', 'b', 'c']);
    expect(result.jobs.every(job => job.state === 'verified')).toBe(true);
  });

  it('blocks dependents at the verification gate when a candidate needs review', async () => {
    const dependencies: DelegationGraphDependencies = {
      executeTask: async input => completed(input.objective, input.objective === 'first' ? 'review_required' : 'pass'),
    };
    const result = await executeDelegationGraph({
      jobs: [
        { id: 'a', task: task('first', 'a.ts') },
        { id: 'b', depends_on: ['a'], task: task('second', 'b.ts') },
      ],
    }, dependencies);
    expect(result.status).toBe('needs_review');
    expect(result.jobs[0].state).toBe('needs_review');
    expect(result.jobs[1]).toMatchObject({ state: 'blocked', blocked_by: ['a'] });
  });

  it('cancels pending work before dispatch when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await executeDelegationGraph({
      jobs: [{ id: 'a', task: task('a', 'a.ts') }],
    }, { executeTask: async () => { calls++; return completed('1'); } }, controller.signal);
    expect(calls).toBe(0);
    expect(result.status).toBe('cancelled');
    expect(result.cancellation_reason).toBe('caller_cancelled');
    expect(result.jobs[0].state).toBe('cancelled');
  });
});
