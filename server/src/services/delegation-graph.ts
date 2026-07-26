import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  delegateTaskSchema,
  executeDelegateTask,
  type DelegateTaskResult,
} from './delegation.js';

const graphJobSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  depends_on: z.array(z.string()).max(50).default([]),
  owns_files: z.array(z.string().min(1).max(500)).max(100).default([]),
  owns_logical_scopes: z.array(z.string().min(1).max(500)).max(100).default([]),
  parallel_safety: z.enum(['safe', 'serialized', 'exclusive']).default('safe'),
  task: delegateTaskSchema,
}).strict();

export const delegationGraphSchema = z.object({
  feature_brief: z.string().max(10_000).optional(),
  jobs: z.array(graphJobSchema).min(1).max(50),
  max_parallel: z.number().int().min(1).max(8).default(3),
  time_limit_ms: z.number().int().min(1_000).max(600_000).default(120_000),
}).strict();

export type DelegationGraphInput = z.infer<typeof delegationGraphSchema>;

export type DelegationJobState =
  | 'pending'
  | 'running'
  | 'verified'
  | 'needs_review'
  | 'abstained'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface DelegationGraphPlan {
  graph_hash: string;
  context_hash: string | null;
  levels: string[][];
  ownership: Record<string, { files: string[]; logical_scopes: string[] }>;
  max_parallel: number;
  deterministic_order: string[];
}

export interface DelegationGraphJobResult {
  id: string;
  state: DelegationJobState;
  result: DelegateTaskResult | null;
  blocked_by: string[];
}

export interface DelegationGraphResult {
  status: 'completed' | 'needs_review' | 'failed' | 'cancelled';
  plan: DelegationGraphPlan;
  jobs: DelegationGraphJobResult[];
  started_at: string;
  duration_ms: number;
  cancellation_reason: string | null;
}

export interface DelegationGraphDependencies {
  executeTask: typeof executeDelegateTask;
}

const defaultDependencies: DelegationGraphDependencies = {
  executeTask: executeDelegateTask,
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeOwner(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function isAncestor(
  ancestor: string,
  descendant: string,
  byId: Map<string, z.infer<typeof graphJobSchema>>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(descendant)) return false;
  seen.add(descendant);
  const job = byId.get(descendant);
  if (!job) return false;
  if (job.depends_on.includes(ancestor)) return true;
  return job.depends_on.some(parent => isAncestor(ancestor, parent, byId, seen));
}

function topologicalLevels(input: DelegationGraphInput): string[][] {
  const byId = new Map(input.jobs.map(job => [job.id, job]));
  if (byId.size !== input.jobs.length) throw new Error('job ids must be unique');
  for (const job of input.jobs) {
    for (const dependency of job.depends_on) {
      if (!byId.has(dependency)) throw new Error(`job ${job.id} depends on unknown job ${dependency}`);
      if (dependency === job.id) throw new Error(`job ${job.id} cannot depend on itself`);
    }
  }

  const remaining = new Set(byId.keys());
  const completed = new Set<string>();
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(id => byId.get(id)!.depends_on.every(dep => completed.has(dep)))
      .sort();
    if (ready.length === 0) throw new Error('delegation graph contains a dependency cycle');
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return levels;
}

function assertOwnershipSafety(input: DelegationGraphInput): void {
  const byId = new Map(input.jobs.map(job => [job.id, job]));
  for (let i = 0; i < input.jobs.length; i++) {
    for (let j = i + 1; j < input.jobs.length; j++) {
      const a = input.jobs[i];
      const b = input.jobs[j];
      if (isAncestor(a.id, b.id, byId) || isAncestor(b.id, a.id, byId)) continue;
      const aFiles = new Set(a.owns_files.map(normalizeOwner));
      const fileConflicts = b.owns_files.map(normalizeOwner).filter(owner => aFiles.has(owner));
      const aScopes = new Set(a.owns_logical_scopes.map(normalizeOwner));
      const scopeConflicts = b.owns_logical_scopes.map(normalizeOwner).filter(owner => aScopes.has(owner));
      if (fileConflicts.length || scopeConflicts.length) {
        throw new Error(
          `parallel ownership conflict between ${a.id} and ${b.id}: ` +
          [...fileConflicts, ...scopeConflicts].join(', '),
        );
      }
    }
  }
}

export function planDelegationGraph(rawInput: unknown): DelegationGraphPlan {
  const input = delegationGraphSchema.parse(rawInput);
  const levels = topologicalLevels(input);
  assertOwnershipSafety(input);
  const replayShape = {
    max_parallel: input.max_parallel,
    jobs: input.jobs.map(job => ({
      id: job.id,
      depends_on: [...job.depends_on].sort(),
      owns_files: job.owns_files.map(normalizeOwner).sort(),
      owns_logical_scopes: job.owns_logical_scopes.map(normalizeOwner).sort(),
      parallel_safety: job.parallel_safety,
      task: {
        objective_hash: hash(job.task.objective),
        context_hashes: job.task.relevant_context.map(context => hash(context.content)),
        category: job.task.category,
        size: job.task.size,
        risk: job.task.risk,
        output_mode: job.task.output_mode,
        selection_mode: job.task.selection_mode,
      },
    })),
  };
  return {
    graph_hash: hash(stableStringify(replayShape)),
    context_hash: input.feature_brief ? hash(input.feature_brief) : null,
    levels,
    ownership: Object.fromEntries(input.jobs.map(job => [
      job.id,
      {
        files: job.owns_files.map(normalizeOwner),
        logical_scopes: job.owns_logical_scopes.map(normalizeOwner),
      },
    ])),
    max_parallel: input.max_parallel,
    deterministic_order: levels.flat(),
  };
}

function terminalFailure(state: DelegationJobState): boolean {
  return ['needs_review', 'abstained', 'failed', 'blocked', 'cancelled'].includes(state);
}

function resultState(result: DelegateTaskResult): DelegationJobState {
  if (result.status === 'abstained' || result.status === 'insufficient_context') return 'abstained';
  if (result.status !== 'completed' || result.quality_gate === 'rejected') return 'failed';
  return result.quality_gate === 'pass' ? 'verified' : 'needs_review';
}

export async function executeDelegationGraph(
  rawInput: unknown,
  dependencies: DelegationGraphDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<DelegationGraphResult> {
  const input = delegationGraphSchema.parse(rawInput);
  const plan = planDelegationGraph(input);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const deadline = started + input.time_limit_ms;
  const byId = new Map(input.jobs.map(job => [job.id, job]));
  const results = new Map<string, DelegationGraphJobResult>(
    input.jobs.map(job => [job.id, { id: job.id, state: 'pending', result: null, blocked_by: [] }]),
  );
  let cancellationReason: string | null = null;

  while ([...results.values()].some(job => job.state === 'pending')) {
    if (signal?.aborted || Date.now() >= deadline) {
      cancellationReason = signal?.aborted ? 'caller_cancelled' : 'graph_time_limit';
      for (const result of results.values()) {
        if (result.state === 'pending') result.state = 'cancelled';
      }
      break;
    }

    for (const result of results.values()) {
      if (result.state !== 'pending') continue;
      const job = byId.get(result.id)!;
      const blockedBy = job.depends_on.filter(dep => terminalFailure(results.get(dep)!.state));
      if (blockedBy.length > 0) {
        result.state = 'blocked';
        result.blocked_by = blockedBy;
      }
    }

    const ready = [...results.values()]
      .filter(result => result.state === 'pending')
      .filter(result => byId.get(result.id)!.depends_on.every(dep => results.get(dep)!.state === 'verified'))
      .sort((a, b) => plan.deterministic_order.indexOf(a.id) - plan.deterministic_order.indexOf(b.id));
    if (ready.length === 0) break;

    const exclusive = ready.find(result => byId.get(result.id)!.parallel_safety === 'exclusive');
    const serialized = ready.find(result => byId.get(result.id)!.parallel_safety === 'serialized');
    const batch = exclusive ? [exclusive] : serialized ? [serialized] : ready.slice(0, input.max_parallel);
    for (const result of batch) result.state = 'running';

    await Promise.all(batch.map(async jobResult => {
      const job = byId.get(jobResult.id)!;
      const remainingMs = Math.max(1_000, deadline - Date.now());
      const featureContext = input.feature_brief
        ? [{ label: 'feature_continuity_brief', content: input.feature_brief }]
        : [];
      try {
        const result = await dependencies.executeTask({
          ...job.task,
          relevant_context: [...featureContext, ...job.task.relevant_context],
          time_limit_ms: Math.min(job.task.time_limit_ms, remainingMs),
        });
        jobResult.result = result;
        jobResult.state = resultState(result);
      } catch {
        jobResult.state = 'failed';
      }
    }));
  }

  const jobs = plan.deterministic_order.map(id => results.get(id)!);
  const states = jobs.map(job => job.state);
  const status = cancellationReason
    ? 'cancelled'
    : states.some(state => ['failed', 'abstained'].includes(state))
      ? 'failed'
      : states.some(state => state === 'needs_review')
        ? 'needs_review'
        : states.some(state => state === 'blocked')
          ? 'failed'
          : 'completed';
  return {
    status,
    plan,
    jobs,
    started_at: startedAt,
    duration_ms: Date.now() - started,
    cancellation_reason: cancellationReason,
  };
}
