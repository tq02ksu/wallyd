# WALLY Agent Contract

Naming is strict: `WALLY` is the product/robot identity; `wallyd` is the project
and repository identifier. Runtime processes are `robotd`, `agentd`, and
`modeld`. Never rename a process to `wally` or `wallyd`.

## Scope and source of truth

GitHub Issues and pull requests are the only authoritative task records. Work
only on the issue supplied by Symphony, in the current issue-specific
worktree. Do not infer missing product requirements or invent robot APIs,
device protocols, hardware behavior, or application architecture.

Read `README.md`, `WORKFLOW.md`, `docs/architecture.md`, and relevant
`docs/engineering-decisions.md` entries before changing code. Search ai-memory
for prior decisions and investigations, but treat verified repository content
and test results as higher authority than remembered context.

The robot tree has strict ownership:

- `robotd/` owns body state, serial adaptation, task state, and safety behavior.
- `agentd/` owns sessions, UI, optimization policy, and managed Codex lifecycle.
- `contracts/` and `agentd/contracts/` are the machine-readable interface truth.
- `firmware/` owns pulse timing, ENA behavior, and the board-side watchdog.
- `doc/` contains hardware, electrical, protocol, C4, and ADR evidence.

Do not create a second mutable copy of robot state outside `robotd`. The model
tool surface must expose semantic capabilities, never raw GPIO/PWM/serial
operations.

## Required workflow

1. Understand the current architecture and affected public interfaces.
2. Reproduce the problem or define observable acceptance criteria.
3. Use `$tdd-workflow`: add or update tests before implementation when the
   repository has an executable test stack.
4. Implement the smallest coherent change that satisfies the issue.
5. Use `$build-error-resolver` when debugging build or test failures.
6. Use `$code-reviewer` for a focused review of the diff.
7. Use `$security-review` when the change touches input handling, credentials,
   process execution, network access, persistence, or hardware boundaries.
8. Use `$verification-loop` and run all relevant tests before committing.
9. Commit only passing, coherent changes on the issue branch.
10. Leave pushing and pull-request creation to the trusted host-side hook.

The default ECC allowlist is limited to the workflows named above. Do not
invoke the broader ECC agent catalog or trust/configure additional ECC hooks
unless the issue explicitly requires it and the change is reviewed.

## Memory and code intelligence

- Query the `ai-memory` MCP tools for project decisions and prior debugging
  evidence at the start of non-trivial work.
- Record durable findings only after they are verified by tests, repository
  evidence, or an explicit human decision.
- Never write speculation, secrets, tokens, customer data, or unverified
  hardware observations to long-term memory.
- When GitNexus tools are available, use them for symbol search, call-chain
  analysis, and impact analysis before broad refactors. GitNexus licensing
  must be approved before it is enabled.

## Verification commands

Use the isolated Node runtime by prefixing commands with
`PATH=/data/agent-dev/bin:/usr/local/bin:/usr/bin:/bin`. Relevant gates are:

```bash
npm run contract:check
(cd robotd && uv sync --locked --extra dev --python 3.11 && uv run --locked python -m pytest -q)
(cd agentd && npm ci && npm test)
bash scripts/ci/run-gates.sh
```

Hardware-dependent tests are not part of phase-one verification. Simulation tests
must not be presented as real-hardware evidence.

## Git and GitHub boundaries

- Never modify `main` directly.
- Never push, force-push, rewrite, or delete remote branches from Codex.
- Never merge, approve, or close a pull request automatically.
- Keep each issue's changes on its dedicated `ai/GH-<number>` branch.
- Do not put credentials in source files, commands, logs, issue comments, or
  commit messages.
- The GitHub token belongs only to Symphony's host-side process. Codex must
  use Symphony's host-side tools and hooks rather than attempting to obtain
  the token.

## Safety boundaries

- Do not operate, flash, probe, or otherwise interact with real robot hardware.
- Stop and create `.symphony/blocked` containing a concise reason when a
  public-interface change, architecture conflict, missing requirement, or
  required hardware interaction is unavoidable.
- Do not weaken tests, security controls, branch protection, or CI merely to
  make a change pass.

## Definition of done

A task is complete only when its acceptance criteria are met, relevant tests
pass, the diff has been reviewed for security and compatibility, the worktree
is clean after commit, and the commit is ready for the host-side publisher to
open a pull request for human review.
