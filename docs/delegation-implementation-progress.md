# Intelligent delegation implementation progress

## Current phase and checkpoint

- Branch: `codex/intelligent-delegation-dev`
- Current phase: Phase 2
- Checkpoint: privacy-safe feedback history and evidence-bounded adaptive routing
- Remote status: quality policies pushed; adaptive-history checkpoint pending

## Architecture decisions

- Selection mode is a separate concept from the existing routing strategy. The
  initial API names `standard`, `task_aware`, and `adaptive`; existing routing
  strategies remain unchanged.
- MCP is an authenticated, stateless transport. Delegation execution lives in a
  separate service and uses the existing router, provider adapters, and shared
  fallback loop.
- Workers receive only caller-supplied context. They have no filesystem, shell,
  patch application, database, credential, commit, or push capability.
- Worker output is always untrusted and always requires Codex review.
- Task packets, prompts, and policy are versioned. Context receipts contain
  hashes and redaction counts, never raw context.
- Automated provider tests use injected mock providers.

## Files changed

- Existing planning checkpoint:
  - `.gitignore`
  - `docs/README.md`
  - `docs/intelligent-codex-delegation.md`
- Phase 1:
  - `server/src/services/delegation.ts`
  - `server/src/routes/mcp.ts`
  - `server/src/__tests__/services/delegation.test.ts`
  - `server/src/__tests__/routes/mcp.test.ts`
  - `docs/intelligent-delegation-api.md`
  - `docs/delegation-implementation-progress.md`
- Phase 2 task-aware selection:
  - `server/src/services/router.ts`
  - `server/src/services/delegation.ts`
  - `server/src/__tests__/services/delegation-routing.test.ts`
  - `server/src/__tests__/services/delegation.test.ts`
- Phase 2 specialized tools:
  - `server/src/routes/mcp.ts`
  - `server/src/services/delegation.ts`
  - `server/src/__tests__/routes/mcp.test.ts`
  - `server/src/__tests__/services/delegation.test.ts`
- Phase 2 quality policies:
  - `server/src/services/delegation.ts`
  - `server/src/routes/mcp.ts`
  - `server/src/__tests__/services/delegation.test.ts`
  - `server/src/__tests__/routes/mcp.test.ts`
- Phase 2 adaptive history:
  - `server/src/db/migrations/20260727_000001_delegation_history.ts`
  - `server/src/db/migrate/defaults.ts`
  - `server/src/services/delegation.ts`
  - `server/src/services/router.ts`
  - `server/src/routes/mcp.ts`
  - `server/src/__tests__/db/migrate/roundtrip.test.ts`
  - `server/src/__tests__/db/migrate/delegation-history.test.ts`
  - delegation, routing, and MCP tests

## Verification log

| Command | Result |
|---|---|
| `npm test` | Baseline: failed only in two Windows permission-bit assertions in `server/src/__tests__/db/hardening.test.ts` (`mode & 0o077` was `54`). All other tests reached by the suite passed. |
| `npm run build` | Baseline passed. Vite reported its existing large-chunk warning. |
| `npm run build -w server` | Phase 1 TypeScript build passed. |
| Targeted delegation + MCP tests | Final rerun passed: 2 files, 26 tests. The first run had one new private-key redaction failure; the regex was corrected before the gate. |
| `npm test` | Phase 1 gate: all delegation and existing tests passed except the same two pre-existing Windows permission-bit assertions in `db/hardening.test.ts`. |
| `npm run build` | Phase 1 gate passed for server and client; existing Vite large-chunk warning remains. |
| Targeted Phase 2 routing tests | Task-aware, adaptive fallback, standard compatibility, existing router, MCP, and delegation tests: 4 files, 43 tests passed after tuning high-risk capability weighting. |
| Targeted preset/comparison tests | Specialized presets, two-model diversity, and MCP schemas: 2 files, 31 tests passed. |
| Targeted quality-policy tests | Patch risk/scope, test-deletion rejection, shadow isolation, adversarial review, selection compatibility, and MCP schemas: 4 files, 50 tests passed. |
| Adaptive history and migration tests | Feedback, privacy-safe telemetry, minimum evidence fallback, bounded adaptive score, general migration round trip, and focused migration checks: 6 files, 60 tests passed. |
| `npm test` | Phase 2 gate: all new and existing tests passed except the same two pre-existing Windows permission-bit assertions in `db/hardening.test.ts`. |
| `npm run build` | Phase 2 gate passed for server and client; existing Vite large-chunk warning remains. |

The first sandboxed test attempt could not load the Vitest configuration because
esbuild was denied access above the workspace. Required test/build commands are
therefore run with the approved unsandboxed execution path.

## Commits and pushes

- `5e03234 docs: define delegation architecture and rollout` — pushed to
  `origin/codex/intelligent-delegation-dev`.
- `6c3fa57 feat: add bounded delegate_task MCP tool` — pushed to
  `origin/codex/intelligent-delegation-dev`.
- `26b30b3 feat: add task-aware model selection mode` — pushed to
  `origin/codex/intelligent-delegation-dev`.
- `03cd864 feat: add specialized delegation presets` — pushed to
  `origin/codex/intelligent-delegation-dev`.
- `1c4264f feat: add delegation verification and telemetry` — pushed to
  `origin/codex/intelligent-delegation-dev`.
- Adaptive-history checkpoint — pending.

## Known limitations

- Task-aware ranking currently uses catalog capability/context metadata layered
  over the existing strategy order. It does not yet use delegation-specific
  historical acceptance evidence.
- Adaptive scoring currently uses reviewed acceptance/revision/rejection and
  regression signals. Token-savings calibration and uncertainty intervals need
  more history and remain deferred.
- Verification commands are intentionally not accepted or executed in Phase 1;
  deterministic verification remains the caller's responsibility.
- The Windows filesystem does not expose POSIX permission bits in the form
  expected by two existing database hardening tests.

## Deferred work

- Phase 2 presets, review policies, feedback, and telemetry.
- Phase 3 dependency-aware job graphs and concurrency controls.
- Phase 4 history-backed adaptive execution.

## Recommended next action

Commit and push adaptive history, then continue with dependency-aware execution
graph foundations.
