# WALLY Contributor and Agent Guide

WALLY is an open-source, WALL-E-inspired DIY robot platform: a Mac mini brain
drives an ESP32-S3 motion controller over USB serial, and owners extend it with
their own attachments, sensors, and skills.

`wallyd` is the repository/project identifier only. It is not a daemon, and this
repository is not a background-job or task-queue system; do not introduce or
describe a `wally`/`wallyd` process. Runtime processes are `robotd`, `agentd`,
and `modeld`.

## Source of truth

GitHub Issues and pull requests are authoritative. Work only on the supplied
issue, in its assigned branch/worktree. Do not infer missing requirements or
invent robot APIs, device protocols, hardware behavior, or architecture.

Read the relevant product documentation before changing code:

- `docs/project/architecture.md`
- `docs/architecture.md`
- `docs/communication-protocol.md`
- `contracts/openapi.yaml` and `agentd/contracts/openapi.yaml`
- relevant ADRs under `docs/decisions/`

## Ownership rules

- `robotd/` owns body state, serial adaptation, task state, and safety behavior.
- `agentd/` owns sessions, UI, orchestration, approvals, and managed Codex
  lifecycle inside the robot product.
- `modeld` is a separate slow-model process.
- `firmware/` owns pulse timing, ENA behavior, and the board-side watchdog.
- Contracts are the only machine-readable interface source.

Do not create a second mutable copy of robot state outside `robotd`. The model
tool surface exposes semantic capabilities, never raw GPIO, PWM, or serial
operations.

## Development workflow

1. Understand affected interfaces and reproduce the behavior.
2. Add or update a failing test before behavior changes.
3. Implement the smallest coherent change.
4. Review the diff for compatibility and security.
5. Run the relevant simulation, contract, and unit gates.
6. Commit coherent changes with a conventional commit message.
7. Never merge a pull request without human review.

Contract changes follow: contract -> generated artifacts -> tests ->
implementation. Do not hand-edit generated files.

## Verification

```bash
npm ci
npm run contract:check
(cd robotd && uv sync --locked --extra dev --python 3.11)
(cd agentd && npm ci && npm test)
bash scripts/ci/run-gates.sh
```

Hardware-dependent tests are not part of default CI. Simulation evidence must
not be presented as real-hardware validation.

## Safety boundaries

- Do not flash firmware, energize motor drivers, move motors, or operate a
  camera on real hardware without explicit human authorization.
- Do not weaken tests, safety checks, branch protection, or CI to make a change
  pass.
- Do not place credentials in source, logs, issues, comments, or commits.
- Stop and report when requirements conflict, a public interface must change,
  or hardware access is unavoidable.

## Definition of done

Acceptance criteria are met, relevant tests pass, the diff is reviewed, no
unverified hardware claims were added, and the work is ready for human review.
