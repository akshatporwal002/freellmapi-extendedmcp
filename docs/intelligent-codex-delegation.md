# Intelligent Codex Delegation Layer

## Purpose

The delegation layer will extend FreeLLMAPI from a model router into a task-aware
execution service for Codex.

Codex remains the primary engineering agent. It owns repository understanding,
planning, architecture, decomposition, requirements, security decisions, and
final review. Free or low-cost worker models perform bounded implementation
work and return candidate results for Codex to accept, revise, or reject.

The intended experience is **task-level autocomplete**:

1. Codex decides what should be built.
2. Codex defines the relevant interface, constraints, and acceptance criteria.
3. FreeLLMAPI selects a suitable worker and asks it to complete a bounded gap.
4. The result is verified using deterministic tooling.
5. Codex reviews the resulting patch and remains the final author.

The objective is to reduce premium Codex token usage without lowering the
quality of accepted changes.

## Core design principles

- Worker output is an untrusted candidate, never an authoritative change.
- Codex retains responsibility for high-judgement decisions.
- Delegated tasks must have explicit boundaries and acceptance criteria.
- Workers return patches or analysis; they do not commit or merge changes.
- Deterministic tools are preferred over model reasoning whenever possible.
- A worker may abstain when context is missing or confidence is low.
- Quality and net premium-token savings are measured continuously.
- Large or ambiguous tasks are decomposed before they are delegated.

## Planned MCP interface

The first release will expose one general-purpose MCP tool:

```ts
delegate_task({
  objective,
  category,
  size,
  risk,
  files,
  relevantContext,
  constraints,
  acceptanceCriteria,
  verificationCommands,
  output
})
```

Initial task categories:

- `implementation`
- `bug_fix`
- `debugging`
- `testing`
- `documentation`
- `review`
- `refactoring`
- `research`
- `repository_analysis`

Initial output modes:

- `patch`: return a unified diff for Codex review.
- `analysis`: return findings without modifying files.

The general tool provides one stable execution contract while the system is
being validated. The following specialised tools are also planned:

### `delegate_code_generation`

Generate a bounded implementation from interfaces, invariants, examples, and
acceptance criteria supplied by Codex. Intended uses include isolated function
bodies, adapters, CRUD endpoints, serialization code, and boilerplate. The
result is returned as a patch and remains subject to verification and Codex
review.

### `delegate_tests`

Generate unit, integration, regression, or edge-case tests from behaviour
specified by Codex. The tool will identify assumptions separately from the
generated patch and run only allowlisted test commands.

### `delegate_review`

Review a patch or selected files for correctness, regressions, maintainability,
missing tests, and violations of supplied invariants. A review model should
normally differ from the implementation model to reduce correlated mistakes.
Findings will be structured by severity and include precise file references.

### `delegate_documentation`

Create or update documentation from completed code, public interfaces, examples,
and a Codex-provided outline. It may produce API documentation, README sections,
migration notes, changelogs, or explanatory comments without inventing
unsupported behaviour.

### `delegate_debugging`

Analyse a contained failure using error output, reproduction steps, relevant
files, and recent changes. The tool may propose a root cause, request missing
evidence, suggest diagnostic commands, or return a candidate patch. Ambiguous or
security-sensitive debugging will return to Codex.

### `compare_model_outputs`

Send the same bounded task to multiple suitable models and compare their
answers. It may be used when:

- Confidence in a single result is low.
- The task has several plausible implementations.
- An independent review would materially reduce risk.
- Historical evidence does not clearly favour one model.

The comparison result will preserve each candidate, verification outcome, token
usage, and model identity. A designated judge may rank candidates, but Codex
retains the final selection. This feature can build on FreeLLMAPI's existing
multi-model fusion capabilities.

The specialised tools may initially be implemented as validated presets over
`delegate_task`. This keeps routing, verification, telemetry, retries, and
security policy consistent while giving Codex clearer task-specific interfaces.

## Task analysis and decomposition

Before dispatch, the delegation layer will determine whether the requested work
is sufficiently bounded. It will consider:

- Whether the objective is unambiguous.
- Whether the permitted files and interfaces are known.
- Whether success can be verified.
- Whether the task fits within an available model's context window and quota.
- Whether the expected Codex review cost is likely to erase the token saving.
- Whether the task can execute independently or has unmet dependencies.

Small and medium tasks may be delegated directly. Large tasks will produce a
decomposition proposal containing smaller dependency-aware jobs for Codex to
approve or revise. The scheduler will not independently make architectural
decisions while decomposing work.

## Worker roles

FreeLLMAPI will present available capacity to Codex as a pool of bounded worker
roles rather than as replacement general-purpose agents:

- **Implementer:** fills a specified code gap.
- **Test author:** turns acceptance criteria into executable tests.
- **Reviewer:** independently inspects a proposed change.
- **Documentation writer:** explains completed and verified behaviour.
- **Debugger:** investigates a reproducible, contained failure.
- **Researcher:** gathers or compares technical options within a supplied scope.

Roles are execution profiles, not permanently assigned models. The scheduler
selects the most suitable currently available model for each role and task.

## Delegation task packet

Codex will supply a compact, structured completion packet containing:

- A precise objective.
- The files the worker may inspect or change.
- Only the repository context relevant to the task.
- Existing interfaces and data structures that must be preserved.
- Input, output, and behavioural contracts.
- Correctness and security invariants.
- Forbidden changes, such as adding dependencies or changing public exports.
- Acceptance criteria and examples.
- Allowlisted verification commands.
- The required output format.

This packet is intended to give a worker enough context to implement a local
change without asking it to reason about the entire repository.

## Classification and delegation policy

Each task will be classified across several dimensions:

- **Category:** implementation, testing, documentation, review, and so on.
- **Size:** small, medium, or large.
- **Risk:** low, medium, or high.
- **Ambiguity:** whether the task has a complete and testable contract.
- **Context requirement:** estimated repository and prompt context.
- **Parallel safety:** whether it can run independently of other work.

Good initial delegation targets include:

- Function bodies with stable signatures.
- Unit and integration tests derived from specified behaviour.
- Repetitive adapters, mappings, and CRUD code.
- Documentation based on completed interfaces.
- Boilerplate and serialization code.
- Mechanical, tightly scoped refactors.
- Independent code-review passes.

Architecture, security-sensitive code, ambiguous debugging, repository-wide
refactors, and final integration will normally remain with Codex.

Large tasks will be returned for decomposition rather than sent directly to a
worker.

## Task-aware model scheduling

The scheduler will build on FreeLLMAPI's existing routing, quota, health,
cooldown, and failover capabilities. Model selection will additionally consider:

- Task category, size, risk, and required capabilities.
- Estimated input and output tokens.
- Available context window.
- Remaining provider and key capacity.
- Current concurrency and provider load.
- Historical success for similar tasks.
- Codex acceptance and rewrite history.
- Compile, lint, type-check, and test outcomes.
- Latency, retry rate, and recent provider health.
- Whether the model already worked successfully on the same feature.

The scheduler may reuse a successful model for related implementation work to
preserve consistency. Review may intentionally use a different model to reduce
correlated mistakes.

## Quality-preservation pipeline

Delegated coding work will pass through:

```text
Worker candidate
  -> output/schema validation
  -> formatter
  -> linter
  -> type checker
  -> targeted tests
  -> Codex review
  -> accept, revise, reject, retry, or escalate
```

Verification commands must be explicitly allowlisted. The service will capture
exit status and concise diagnostics, returning full logs only when needed.

Passing deterministic checks is evidence, not proof of correctness. Codex must
still review behaviour, assumptions, maintainability, security, and consistency
with the wider repository.

## Confidence, abstention, and escalation

Workers will be permitted to return a structured abstention:

```json
{
  "status": "insufficient_context",
  "missing": ["Definition of SessionPolicy"],
  "confidence": 0.42
}
```

This avoids forcing a model to fabricate assumptions. Low-confidence or failed
tasks will follow a bounded escalation ladder:

1. Deterministic tool or transformation.
2. Fast free worker model.
3. Stronger free worker model.
4. Alternative model for review or correction.
5. Return to Codex with the attempt history and relevant diagnostics.

Retries will be limited so that repeated worker failures do not consume more
Codex review time than direct implementation.

## Progressive trust

Trust will be earned separately for each model and task category:

- **Suggest:** snippets or analysis only.
- **Draft:** return an unverified patch for Codex review.
- **Verified draft:** return a patch after deterministic checks pass.
- **Routine acceptance candidate:** allow streamlined review for proven,
  low-risk task types.

High-risk work will continue to require explicit Codex review regardless of a
model's historical performance.

## Token estimation and savings measurement

For every delegated task, the system will record:

- Estimated and actual worker input tokens.
- Estimated and actual worker output tokens.
- Premium tokens used to plan and review the delegation.
- Number of retries and models attempted.
- Patch size and Codex edit distance.
- Whether Codex accepted, revised, rewrote, or rejected the result.
- Estimated premium tokens required for direct Codex implementation.
- Latency and deterministic verification results.

Initial token estimates will use simple heuristics based on prompt size,
selected-file size, category, and output limits. Learned prediction can be added
after enough verified execution history exists.

Delegation should be disabled for a model/category pairing when the combined
cost of specification, retries, and Codex review is consistently greater than
direct Codex implementation.

## Historical performance and adaptive routing

A local database will maintain task-specific performance profiles for each
model. Signals will remain separate rather than being collapsed prematurely
into a single success score.

Planned signals include:

- Codex accepted without edits.
- Codex accepted after minor edits.
- Codex substantially rewrote the patch.
- Codex rejected the patch.
- Compile, lint, type-check, and test success.
- Regressions discovered after acceptance.
- Average review effort and edit distance.
- Latency, retries, and provider failures.
- Token-estimation error.
- Net premium-token savings.

Once sufficient data exists, the router can use these outcomes to adapt model
selection automatically.

## Concurrency and workspace isolation

Independent tasks may run concurrently, such as implementation, tests, and
documentation for one feature.

To avoid collisions:

- Workers will initially return patches without applying them.
- Parallel tasks must declare file ownership or permitted paths.
- Conflicting patches will be detected before integration.
- A future execution mode may use isolated temporary worktrees.
- Provider and model concurrency limits will be respected.
- Codex will control final patch ordering and integration.

## Capacity and catalogue awareness

Scheduling will use the existing remote model catalogue and adapt to:

- Newly available or retired models.
- Context-window and capability changes.
- Provider compatibility changes.
- Quota and rate-limit updates.
- Key health, cooldowns, and remaining capacity.

Models without sufficient estimated capacity or context will be excluded before
assignment rather than failing after selection.

## Security and privacy

The delegation layer will include:

- Provider allowlists and denylists.
- Task-level sensitivity and risk labels.
- Secret detection and redaction before external requests.
- Minimal context sharing.
- Explicit file and command allowlists.
- No arbitrary worker-provided shell execution.
- Audit records showing which provider received which task.
- Conservative policies for authentication, cryptography, permissions, and
  other security-sensitive code.

Users remain responsible for complying with each upstream provider's terms and
for deciding which source code may be sent to that provider.

## Continuous execution

A later phase may add a persistent task queue supporting:

- Codex-created work plans.
- Dependency-aware task scheduling.
- Concurrent worker allocation.
- Verification and bounded retries.
- Pausing when Codex judgement is required.
- Resuming after Codex accepts, revises, or decomposes a task.

Continuous operation will mean continuous execution of approved bounded work,
not continuous unsupervised architectural reasoning.

## Delegation budgets and stop-loss controls

Every delegated job will have explicit limits for:

- Worker input and output tokens.
- Estimated premium tokens required for Codex review.
- Number of worker attempts.
- Number of distinct models attempted.
- Wall-clock execution time.
- Verification time and command count.

When a limit is reached, the scheduler will stop retrying and return control to
Codex with the best candidate, verification evidence, and attempt history. This
prevents a failed delegation from consuming more time or tokens than direct
Codex implementation.

## Shadow-mode evaluation

The system will support a shadow mode in which workers attempt tasks without
their output being used. Their candidates will be compared with work completed
normally by Codex.

Shadow mode will help establish:

- Which task categories are genuinely delegatable.
- Which models produce acceptable repository-specific results.
- The review effort that delegation would have required.
- Whether estimated token savings survive real verification and review.
- Safe thresholds for progressive trust.

Shadow results will remain clearly separated from production routing metrics so
that unused candidates are not mistaken for accepted work.

## Patch risk and blast-radius scoring

Every candidate patch will receive a risk score based on factors such as:

- Number and type of files changed.
- Changes to public exports or interfaces.
- Dependency and configuration changes.
- Database schema or migration changes.
- Authentication, authorisation, cryptography, or secret-handling changes.
- Shared infrastructure and cross-package impact.
- Test coverage of affected behaviour.
- Unexpected changes outside the permitted paths.

The score will determine required verification, reviewer diversity, and whether
the task must return directly to Codex. High-risk classifications cannot be
downgraded solely because a worker reports high confidence.

## Contract-first delegation

Where practical, Codex will define the contract before delegating implementation:

- Types and public interfaces.
- Behavioural examples.
- Invariants and prohibited behaviour.
- Failing tests or acceptance criteria.
- Performance and compatibility constraints.

Workers will fill the implementation gap without redefining the contract.
Contract changes discovered during execution will be proposed separately for
Codex approval rather than silently incorporated into a patch.

## Patch minimisation and scope enforcement

Candidate patches will be checked for:

- Changes outside the permitted files or symbols.
- Unnecessary formatting or generated-file churn.
- Unrequested public API changes.
- Unexpected new dependencies.
- Large rewrites where a local change was requested.
- Deleted tests, weakened assertions, or disabled checks.

Out-of-scope changes may be removed automatically only when that transformation
is deterministic and safe. Otherwise the candidate will be rejected or returned
to Codex for review. Smaller, focused patches will be preferred when multiple
candidates satisfy the same contract.

## Independent and adversarial review

The review pipeline will support two complementary modes:

- **Blind independent review:** the reviewer receives the requirements and
  candidate patch without the implementer's rationale or identity, reducing
  anchoring on the original model's assumptions.
- **Adversarial review:** the reviewer actively searches for counterexamples,
  unstated assumptions, security failures, race conditions, boundary errors,
  and ways the implementation could pass current tests while remaining wrong.

Reviewer findings will be treated as evidence for Codex, not automatically
applied changes. High-risk work may require both review modes.

## Test-strength verification

Generated tests will be evaluated for more than whether they pass. Planned
checks include:

- Mutation testing that introduces small implementation faults and confirms the
  tests detect them.
- Coverage of specified edge cases and negative paths.
- Detection of tautological assertions and excessive mocking.
- Verification that tests fail against the known broken or pre-change state
  when appropriate.
- Metamorphic or property-based checks for behaviours with useful invariants.

Mutation testing will be selectively enabled because it can be computationally
expensive. Its results will contribute to the quality history of test-authoring
models.

## Context receipts and privacy auditing

Each delegation will create a context receipt recording:

- The repository revision.
- Files, snippets, summaries, and instructions sent.
- Redactions that were applied.
- The selected model and provider.
- Task sensitivity and provider-policy decisions.
- Prompt, schema, and routing-policy versions.

Receipts will avoid storing raw secrets and will follow configurable retention
rules. They provide an auditable explanation of what left the local environment
and make quality failures easier to investigate.

## Content-addressed context cache

Repository context bundles, file summaries, and stable instructions may be
cached using content hashes. Unchanged context can then be reused instead of
being regenerated or resent unnecessarily.

The cache will:

- Invalidate entries when source content or summarisation policy changes.
- Keep provider-specific privacy boundaries.
- Track whether a worker received source text, a summary, or a cached reference.
- Avoid mixing context across repositories or users.
- Report worker-token savings separately from premium-token savings.

Provider APIs that do not support reusable prompt caching will continue to
receive the required context normally.

## Feature-level continuity

Related tasks may share a compact feature brief containing:

- Agreed requirements and terminology.
- Interfaces and architectural decisions.
- Coding and testing conventions.
- Known risks and unresolved questions.
- Rejected alternatives and the reasons they were rejected.
- Completed jobs and current verification status.

The brief reduces repeated context while preserving consistency across
implementation, tests, documentation, and review. It will be versioned and
approved by Codex when material decisions change.

## Capability canaries

The scheduler may periodically run small, known-answer tasks against available
models. These canaries will detect:

- Silent provider model substitutions or alias changes.
- Degraded instruction following or structured-output support.
- Tool-call and patch-format regressions.
- Changes in latency, reliability, or context handling.
- Catalogue claims that no longer match observed capability.

Canary failures can lower a model's trust level or temporarily exclude it from
specific task categories without disabling it globally.

## Prompt, schema, and policy versioning

Every execution record will identify:

- Worker and reviewer prompt versions.
- Delegation task schema version.
- Model parameters and capability profile.
- Routing and verification policy versions.
- Remote catalogue version.
- Repository revision and feature-brief version.

Performance measurements will be segmented when these inputs change. This
prevents improvements or regressions caused by prompt and policy changes from
being incorrectly attributed to the model.

## Deterministic replay

Failed or disputed delegations will be reproducible from their stored execution
record, subject to provider availability and retention policy. Replay will
reconstruct the task packet, repository revision, model configuration,
verification policy, and relevant context receipt.

Replays will be marked as new executions and will never silently overwrite the
original result. When the original model is unavailable, the system will record
that an approximate replay used a substitute.

## Counterfactual routing evaluation

Routing can become self-reinforcing if the scheduler gathers evidence only for
models it already prefers. The system may therefore send a small, controlled
sample of suitable jobs to alternative models or evaluate alternatives in
shadow mode.

Counterfactual evaluation will:

- Use strict exploration budgets.
- Avoid sensitive and high-risk tasks.
- Compare candidates with the same contract and verification.
- Record the opportunity cost of exploration.
- Feed evidence into task-specific routing without overriding the quality floor.

## Dependency-aware job graphs

Features may be represented as jobs with explicit dependencies, ownership, and
verification gates. For example:

```text
Interface contract
  -> implementation
  -> targeted tests
  -> documentation
  -> independent review
  -> Codex integration
```

Only jobs without unmet dependencies and with non-conflicting file boundaries
will run concurrently. A failed upstream job will block dependent work and
return a concise status to Codex rather than allowing workers to continue from
invalid assumptions.

## Regression attribution

Initial verification success is not the final quality signal. When later tests,
incidents, or Codex review identify a regression, the system may link it back to
the accepted worker patch and update:

- The model's repository- and category-specific history.
- The prompt and verification policy used.
- The task's risk and confidence calibration.
- The effectiveness of the original reviewer.

Attribution must retain uncertainty when several changes could have caused the
failure. Late regressions will not be treated as definitively model-caused
without supporting evidence.

## Quality floors

Delegation policies may require minimum observed performance for each task
category, risk level, and repository. Example requirements include:

- Minimum Codex acceptance rate.
- Maximum substantial-rewrite rate.
- Minimum deterministic verification success.
- Maximum known-regression rate.
- Sufficient sample size and recent capability-canary health.

If no available free model meets the required floor, the task remains with
Codex. Provider availability will never lower the configured quality threshold.

## Repository-specific learning

Performance will be maintained at multiple levels:

- Global model and task-category performance.
- Language and framework performance.
- Repository-specific performance.
- Feature- or subsystem-specific performance where enough evidence exists.

Repository-specific evidence will receive greater weight for local routing, but
the scheduler will fall back to broader evidence when the local sample is too
small. Data from one repository will not expose source content or private
signals to another.

## Savings estimates and confidence intervals

Token savings will be reported as an estimated range rather than an exact
number. The calculation will include:

- Codex planning and task-packet creation.
- Worker generation and retries.
- Verification and result summarisation.
- Codex review and rewriting.
- The estimated cost of direct Codex implementation.

Confidence will depend on the amount and recency of comparable historical data.
The system will distinguish premium-token savings, worker-token usage, latency,
and provider capacity rather than combining them into one misleading number.

## Rollout plan

### Phase 1: Safe task-level autocomplete

- Add the `delegate_task` MCP tool.
- Require caller-supplied category, risk, boundaries, and acceptance criteria.
- Support documentation, testing, review, and isolated implementation tasks.
- Return unified diffs or analysis without applying changes.
- Run allowlisted deterministic verification.
- Record routing, token, verification, and Codex acceptance data.
- Enforce delegation budgets, stop-loss limits, and patch scope.
- Record context receipts and version execution policies.
- Provide shadow mode for baseline evaluation.

### Phase 2: Quality and routing intelligence

- Add task-specific presets for `delegate_code_generation`, `delegate_tests`,
  `delegate_review`, `delegate_documentation`, and `delegate_debugging`.
- Add `compare_model_outputs` for selected low-confidence or high-value tasks.
- Add task-aware scoring to the existing router.
- Introduce progressive trust by model and category.
- Add confidence and structured abstention.
- Measure Codex edit distance and net premium-token savings.
- Add bounded retry and escalation policies.
- Support deliberate model diversity for review.
- Add patch risk scoring, quality floors, and blind review.
- Add adversarial review and selective test-strength verification.
- Begin repository-specific performance tracking.

### Phase 3: Parallel execution

- Detect task dependencies and file conflicts.
- Add concurrency and provider balancing.
- Optionally execute workers in isolated worktrees.
- Coordinate implementation, tests, documentation, and review as separate jobs.
- Introduce dependency-aware job graphs and feature-level continuity briefs.
- Add content-addressed context caching where providers support safe reuse.
- Add deterministic replay for failed and disputed executions.

### Phase 4: Adaptive execution engine

- Improve token and complexity prediction from historical data.
- Learn model/category performance profiles.
- Add automatic decomposition recommendations.
- Add dependency-aware queues and resumable continuous execution.
- Adapt scheduling automatically as the remote model catalogue changes.
- Run capability canaries and controlled counterfactual routing evaluation.
- Attribute late regressions to relevant execution and review histories.
- Report savings estimates with calibrated confidence intervals.

## Success criteria

The delegation layer will be considered successful when it:

- Preserves Codex as the final decision-maker.
- Produces patches that Codex accepts with little or no rewriting.
- Detects low-confidence and unsuitable tasks before bad code is integrated.
- Passes deterministic checks without hiding semantic risk.
- Reduces premium-token usage after including planning and review overhead.
- Improves routing decisions from measured outcomes.
- Fails safely by returning control and evidence to Codex.
