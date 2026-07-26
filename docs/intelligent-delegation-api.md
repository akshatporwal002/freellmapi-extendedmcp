# Intelligent delegation API

FreeLLMAPI exposes bounded worker inference through the authenticated,
stateless MCP endpoint at `POST /mcp`. Delegation never grants a worker access
to the repository or a command runner. The caller supplies the relevant source
text, and the worker returns an untrusted patch or analysis for Codex review.

## `delegate_task`

The tool requires an objective, task classification, caller-supplied context,
acceptance criteria, and an output mode. Unknown fields are rejected. Paths are
labels and scope constraints only: they must be repository-relative, and the
service never reads them.

`selection_mode` is separate from the existing routing strategy:

- `standard` preserves normal FreeLLMAPI routing.
- `task_aware` is the delegation default and is the extension point for
  task-category, size, risk, capability, context, quota, health, latency, and
  concurrency scoring. It layers task suitability over the active routing
  strategy's normal ordering; high-risk tasks give capability more weight,
  while low-risk tasks preserve more of the standard order.
- `adaptive` extends task-aware selection when sufficient verified history
  exists. Until that evidence exists, it uses task-aware ranking and returns
  `"selection_mode_fallback": "task_aware"`.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "delegate_task",
    "arguments": {
      "objective": "Implement parseMode without changing its public signature.",
      "category": "implementation",
      "size": "small",
      "risk": "low",
      "relevant_context": [
        {
          "path": "server/src/lib/mode.ts",
          "content": "export function parseMode(value: string): Mode { /* gap */ }"
        },
        {
          "path": "server/src/lib/mode.test.ts",
          "content": "it('rejects unknown modes', () => { /* ... */ })"
        }
      ],
      "permitted_files": ["server/src/lib/mode.ts"],
      "logical_boundaries": ["Only implement parseMode"],
      "constraints": ["Do not add dependencies", "Do not change exports"],
      "invariants": ["Unknown values throw"],
      "acceptance_criteria": ["Return a minimal unified diff", "Existing tests remain valid"],
      "output_mode": "patch",
      "selection_mode": "task_aware",
      "input_token_limit": 8000,
      "output_token_limit": 1200,
      "max_attempts": 2,
      "time_limit_ms": 30000
    }
  }
}
```

Authenticate with the same unified bearer key used by the `/v1` endpoints.

### Result

The MCP result contains one text block whose text is JSON:

```json
{
  "task_id": "9a15c073-1111-4f64-8b88-85b0d98d5f1d",
  "status": "completed",
  "output_mode": "patch",
  "candidate": "diff --git a/server/src/lib/mode.ts b/server/src/lib/mode.ts\n...",
  "confidence": 0.86,
  "abstention": null,
  "selection_mode": "task_aware",
  "selected_model": "example-model",
  "selected_provider": "example-provider",
  "usage": {
    "input_tokens": 680,
    "output_tokens": 140,
    "estimated": false
  },
  "attempts": [
    {
      "ordinal": 0,
      "platform": "example-provider",
      "model": "example-model",
      "outcome": "success"
    }
  ],
  "validation_warnings": [],
  "codex_review_required": true,
  "versions": {
    "schema": "1.0",
    "prompt": "1.0",
    "policy": "1.0"
  },
  "context_receipt": {
    "entries": [
      {
        "path": "server/src/lib/mode.ts",
        "sha256": "64-character-content-hash",
        "redactions": 0
      }
    ]
  }
}
```

`status` may also be `abstained`, `insufficient_context`, or `failed`.
Abstentions include a reason and missing-context list. Provider and model
identities are included only when a route was selected. Usage is estimated when
the provider omits token accounting.

## Specialized tools

Five tools are strict presets over `delegate_task`; their schema omits
caller-overridable `category` and `output_mode` fields:

- `delegate_code_generation` — implementation patch.
- `delegate_tests` — test patch.
- `delegate_review` — review analysis.
- `delegate_documentation` — documentation patch.
- `delegate_debugging` — debugging analysis.

`compare_model_outputs` runs the same complete task packet twice. The second
run excludes the first selected model, preserving both candidates, usage,
attempts, and validation warnings. It reports whether model diversity was
achieved and a deterministic preference based on completion status, confidence,
and validation warnings. The preference is evidence only; Codex still decides.

## Safety and validation

- Likely credentials and private keys are redacted before inference.
- Absolute paths, parent traversal, and unknown task fields are rejected.
- Caller-provided content is explicitly treated as untrusted data to limit
  prompt-injection influence.
- Input, output, attempt, and wall-clock budgets are bounded.
- The shared router and fallback loop own route selection, leases, cooldowns,
  retry classification, and failover.
- Patch paths are compared with `permitted_files`; violations are returned as
  validation warnings and a rejected quality gate.
- Patch assessments report file count, additions, deletions, changed paths,
  scope violations, risk score/level, and concrete risk signals. Configuration,
  migrations, security-sensitive paths, public exports, broad patches, and test
  deletion raise risk deterministically.
- `quality_gate` is `pass`, `review_required`, or `rejected`. Scope violations,
  test/assertion deletion, and very large patches are rejected while preserving
  the candidate as evidence.
- `shadow_mode: true` marks output evaluation-only and adds a warning that the
  candidate must not be applied.
- `review_mode` may be `blind` or `adversarial`; adversarial review explicitly
  searches for counterexamples, races, security failures, and tests that could
  pass despite incorrect behavior.
- Workers cannot run verification commands. Codex must inspect and apply a
  candidate, then run deterministic checks in the repository.
- `codex_review_required` is always `true`.

## Feedback and adaptive evidence

Every execution gets a UUID `task_id`. The service stores a compact
`delegation_history` row containing hashed repository/context identifiers,
classification, selection mode, model/provider, status, quality gate, token
counts, latency, shadow flag, and policy versions. It never stores the
objective, raw source context, patch, response, or credentials.

Use `record_delegation_feedback` after Codex review:

```json
{
  "task_id": "9a15c073-1111-4f64-8b88-85b0d98d5f1d",
  "outcome": "revised",
  "edit_distance": 14,
  "regression": false,
  "regression_attribution": {
    "relationship": "unrelated",
    "confidence": 0.8
  },
  "review_tokens": 320
}
```

`outcome` is `accepted`, `revised`, or `rejected`. Adaptive routing requires at
least five reviewed, non-shadow observations for the same repository, category,
provider, and model. Below that floor, the result explicitly reports
`selection_mode_fallback: "task_aware"`. With sufficient evidence, a bounded
adjustment derived from observed acceptance quality and regressions augments
task-aware ranking.

Regression attribution is optional and uncertainty-aware. `relationship` is
`possible`, `probable`, `confirmed`, or `unrelated`, paired with a confidence
from zero to one and a consistent `regression` boolean. Adaptive penalties use
the confidence-weighted signal while preserving the raw known-regression rate.

Performance profiles mark whether each historical provider/model pair is still
enabled in the local catalogue. Counterfactual recommendations exclude missing
or disabled models, so historical success cannot route exploration toward
capacity that no longer exists.

## Dependency-aware job graphs

`plan_delegation_graph` validates a graph without inference. Each job declares:

- A stable id and dependency ids.
- File and logical-scope ownership.
- `parallel_safety`: `safe`, `serialized`, or `exclusive`.
- A complete bounded `delegate_task` packet.

The planner rejects unknown dependencies, cycles, and ownership overlap between
jobs that could run concurrently. It returns topological levels, normalized
ownership, a feature-brief hash, and a deterministic replay hash that contains
only task/context hashes and classification metadata.

`execute_delegation_graph` executes ready jobs in deterministic, bounded
parallel batches. Jobs reach explicit states: `pending`, `running`, `verified`,
`needs_review`, `abstained`, `failed`, `blocked`, or `cancelled`. A dependency
may proceed only after its prerequisite returns a `pass` quality gate.
Review-required or failed candidates block downstream work. The graph propagates
its remaining wall-clock budget into each task, stops scheduling after timeout
or cancellation, and never applies worker patches.

An optional `feature_brief` is added as caller-supplied continuity context to
each job. Provider/model concurrency remains enforced by the existing router's
in-flight leases.

## Adaptive evidence and controlled exploration

`delegation_performance_profiles` aggregates reviewed, non-shadow executions by
repository hash, category, provider, and model. Profiles expose acceptance,
revision, rejection, regression, latency, edit-distance, and token evidence.
Usable-rate uncertainty is reported as a Wilson 95% interval, and trust tiers
advance only after explicit sample and outcome thresholds are met.

`evaluate_delegation_counterfactual` ranks historically eligible alternatives
without dispatching them. Its exploration budget is limited to three, and every
recommendation is explicitly `shadow_only`. No alternative is recommended when
the requested repository/category lacks sufficient reviewed evidence.

`recommend_delegation_decomposition` identifies large, high-risk, broad, or
over-context tasks and returns mechanical ownership boundaries. It never
invents job contracts or architecture; any recommendation requires a Codex
decision before it can become an execution graph.

`delegation_capability_canary` runs a normal task packet with forced low risk,
one attempt, and shadow mode. A canary can collect observed capability evidence
without creating a candidate that may be integrated.

`delegate_task` also accepts an optional `quality_floor` with a minimum sample
count, minimum lower confidence bound for usable outcomes, and maximum upper
confidence bound for regressions. Each selected route is checked before
inference. A failing model is skipped without a provider-health penalty; if no
route meets the floor, the task fails safely instead of lowering the policy.
`evaluate_delegation_quality_floor` exposes the same calculation without
dispatching a task.

`estimate_delegation_savings` requires a caller-supplied direct-Codex token
estimate and current planning overhead. Matching reviewed, non-shadow records
with complete worker and review usage produce separate Student-t 95% mean
intervals for premium-token savings, worker usage, and Codex review usage.
Below the requested sample floor it returns `insufficient_evidence`; unreported
rewrite or verification effort is never silently assumed to be zero.

`predict_delegation_tokens` learns prompt, output, and total worker-token ranges
for a category and declared task size. It prefers repository-local observations
and falls back to global observations only when the local sample is too small.
Only provider-reported, non-shadow usage participates; locally estimated usage
is tagged at persistence time and excluded to prevent an estimator from
training on its own output.
