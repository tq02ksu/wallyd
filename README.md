# WALLY

WALLY is an open-source, WALL-E-inspired **DIY robot platform**. The body pairs
a Mac mini as the brain with an ESP32-S3 for real-time motion control over USB
serial. It is a platform, not a fixed product: owners are expected to add their
own attachments, sensors, and skills on top of the base chassis.

`wallyd` is only the name of this GitHub repository and of the
package/project namespace. It is **not** a daemon and **not** a
background-job/task-queue system; the trailing `d` is a historical repository
identifier, not a daemon suffix. Nothing here schedules or runs background
jobs for a server or for the development harness.

## Naming

- **WALLY** is the product and robot identity. Use uppercase WALLY in product
  documentation, UI copy, issue prose, and architecture discussions.
- **wallyd** is the repository/project identifier at
  `github.com/tq02ksu/wallyd` and the package/project namespace. It is not a
  daemon name and must not be read as "wally daemon".
- Runtime process names remain **robotd**, **agentd**, and **modeld**. Do not
  introduce a process called `wally` or `wallyd`.

The runtime follows three explicit process boundaries:

- `robotd`: Python body runtime; owns device state, tasks, safety rules, and
  eventually the serial link to the ESP32.
- `agentd`: TypeScript brain and local UI; owns sessions, task orchestration,
  approvals, and the Codex App Server lifecycle.
- `modeld`: independent slow-model process, isolated so model failures do not
  block robot control.

GitHub Issues and pull requests drive development. Pages in `contracts/` are the
machine-readable interface source, and `docs/` contains hardware, electrical,
software, simulation, and decision records.

> Real-hardware operation requires explicit human authorization. Default
> verification uses simulation and contract tests.

## Hardware baseline

The adopted baseline is documented in [docs/project/hardware-baseline.md](docs/project/hardware-baseline.md).
It is based on an ESP32-S3, two NEMA-17 42BYGH47 steppers, two TB6600 drivers,
a UVC camera, a two-axis gimbal, and a 12 V power bus feeding the Mac mini via a
pure-sine inverter. Power, battery, motor load, and docking remain engineering
validation risks rather than completed claims.

## Local verification

Use Node.js 22.18+ (or 24.11+), Python 3.11+, and uv:

```bash
npm ci
npm run lint
npm run contract:check
(cd robotd && uv sync --locked --extra dev --python 3.11)
npm run test:robotd
(cd agentd && npm ci && npm test)
```

Run `bash scripts/ci/run-gates.sh` (or `npm run gates`) for the complete
offline gate. CI runs the same checks in parallel `static-checks`, `robotd`,
`agentd`, and `integration` lanes, then reports a single `quality` status. The
integration lane starts `robotd --sim` on port 8799 and exercises the agentd
client against it; no hardware is touched. The static lane also runs
`scripts/ci/ci-config.test.mjs`, which regression-tests the source lint gate and
asserts the workflow keeps every lane wired to the required `quality` status.

## Current architecture

- [Architecture overview](docs/project/architecture.md)
- [Hardware and electrical baseline](docs/project/hardware-baseline.md)
- [Robot API](docs/project/robot-api.md)
- [Device protocol](docs/project/device-protocol.md)
- [Robot decision log](docs/decisions/README.md)
- [Detailed inherited robot design](docs/index.md)
