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

## Safety and validation

- Likely credentials and private keys are redacted before inference.
- Absolute paths, parent traversal, and unknown task fields are rejected.
- Caller-provided content is explicitly treated as untrusted data to limit
  prompt-injection influence.
- Input, output, attempt, and wall-clock budgets are bounded.
- The shared router and fallback loop own route selection, leases, cooldowns,
  retry classification, and failover.
- Patch paths are compared with `permitted_files`; violations are returned as
  validation warnings.
- Workers cannot run verification commands. Codex must inspect and apply a
  candidate, then run deterministic checks in the repository.
- `codex_review_required` is always `true`.
