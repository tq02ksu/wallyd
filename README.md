# WALLY

## Naming

- **WALLY** is the product and robot identity. Use uppercase WALLY in product
  documentation, UI copy, issue prose, and architecture discussions.
- **wallyd** is the repository/project identifier at
  `github.com/tq02ksu/wallyd` and the package/project namespace. It is not a
  daemon name.
- Runtime process names remain **robotd**, **agentd**, and **modeld**. Do not
  introduce a process called `wally` or `wallyd`.

WALLY is a Mac mini-based mobile robot platform and its AI-assisted engineering
harness. The runtime follows three explicit process boundaries:

- `robotd`: Python body runtime; owns device state, tasks, safety rules, and
  eventually the serial link to the ESP32.
- `agentd`: TypeScript brain and local UI; owns sessions, task orchestration,
  approvals, and the Codex App Server lifecycle.
- `modeld`: independent slow-model process, isolated so model failures do not
  block robot control.

GitHub Issues and pull requests drive software work. Pages in `contracts/` are
the machine-readable contract source, and `doc/` contains hardware, electrical,
software, and decision records inherited from the reference robot project.

> Phase one validates the software-development loop and simulation only.
> Real robot hardware must not be operated by automation.

## Engineering harness

An issue labeled `ai-ready` is the only automation entry point. Symphony creates
an isolated Git worktree, Codex works under the repository agent contract, and a
trusted host hook publishes the branch and opens a pull request. Pull requests
always require human review and are never auto-merged.

See [AGENTS.md](AGENTS.md), [WORKFLOW.md](WORKFLOW.md), and the
[AI Coding Loop](docs/ai-coding-loop.md). Host-specific installation and service
operations are intentionally maintained outside this repository.

## Hardware baseline

The adopted baseline is documented in [docs/hardware-baseline.md](docs/hardware-baseline.md).
It is based on an ESP32-S3, two NEMA-17 42BYGH47 steppers, two TB6600 drivers,
a UVC camera, a two-axis gimbal, and a 12 V power bus feeding the Mac mini via a
pure-sine inverter. Power, battery, motor load, and docking remain engineering
validation risks rather than completed claims.

## Local verification

Use the isolated runtime shipped with the deployment:

```bash
export PATH=/data/agent-dev/bin:$PATH

npm ci
npm run contract:check
(cd robotd && uv sync --locked --extra dev --python 3.11)
npm run test:robotd
(cd agentd && npm ci && npm test)
```

Run `bash scripts/ci/run-gates.sh` for the complete offline gate.

## Current architecture

- [Architecture overview](docs/architecture.md)
- [Hardware and electrical baseline](docs/hardware-baseline.md)
- [Robot API](docs/robot-api.md)
- [Device protocol](docs/device-protocol.md)
- [Engineering decisions](docs/engineering-decisions.md)
- [Detailed inherited robot design](doc/index.md)
