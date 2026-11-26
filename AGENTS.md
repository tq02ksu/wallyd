# WALLY Contributor and Agent Guide

WALLY is an open-source, WALL-E-inspired DIY robot platform. A Mac mini hosts
the cognitive and autonomy runtimes, while an ESP32-S3 owns real-time device
control over USB serial.

`wallyd` is the repository/project identifier only. It is not a daemon, and this
repository is not a background-job or task-queue system; do not introduce or
describe a `wally`/`wallyd` process. Runtime processes are `robotd`, `agentd`,
and `modeld`.

## Source of truth

GitHub Issues and pull requests are authoritative for implementation scope.
Work only on the supplied issue, in its assigned branch/worktree. Do not infer
missing requirements or invent robot APIs, device protocols, hardware behavior,
or architecture.

The complete architecture and canonical ADRs live in the `projects/wallyd`
documentation directory of `tq02ksu/persona`. This repository keeps a one-page
executable summary and the machine-readable contracts.

Read the relevant product documentation before changing code:

- `docs/project/architecture.md`
- canonical ADRs linked from `docs/decisions/README.md`
- `contracts/openapi.yaml` and `agentd/contracts/openapi.yaml`
- `docs/project/robot-api.md` and `docs/project/device-protocol.md`

## Ownership rules

- `robotd/` exclusively owns the Autonomy Runtime input path: microphone/live
  audio, AEC/VAD, ASR, Safety Word, TTS playback, deterministic routing, tasks,
  actions, state, behavior, motion, resource arbitration, safety, and device
  adaptation. Safety Word runs in parallel with ASR and does not wait for
  `speech.final`.
- `agentd/` is an optional attached cognitive processor: it receives complex
  text/context requests from robotd and owns sessions, UI, open-ended
  orchestration, and managed Codex lifecycle. It does not own the microphone or
  receive live audio. Codex audio capability availability is not a dependency.
- `modeld` is a separate slow-model process.
- `firmware/` owns pulse timing, ENA behavior, and the board-side watchdog.
- Contracts are the only machine-readable interface source.

Do not create a second mutable copy of robot state outside `robotd`. Codex only
sees curated high-level tools, never raw GPIO, PWM, serial operations,
calibration writes, firmware flashing, or internal module RPCs. Normal robot
tasks do not use per-action human approval.

## Development workflow

1. Understand affected interfaces and reproduce the behavior.
2. Add or update a failing test before behavior changes.
3. Implement the smallest coherent change.
4. Review the diff for compatibility and security.
5. Run the relevant simulation, contract, and unit gates.
6. Commit coherent changes with a conventional commit message.
7. Never merge a pull request without human review.

Contract changes follow: contract -> generated artifacts -> tests ->
implementation. Do not hand-edit generated files. Internal module boundaries
must not automatically become public tools; update the curated agent tool schema
explicitly.

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
