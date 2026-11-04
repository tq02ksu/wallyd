# Architecture

WALLY adopts the reference robot's separation between body, brain, and model
processes. This document is the WALLY overview; the detailed C4 and timing
analysis remains in [architecture.md](../architecture.md) and
[layers-and-modules.md](../layers-and-modules.md).

## Robot runtime

```text
user / development client
          |
          v
       agentd  (brain, sessions, approval, UI)
          |  MCP + HTTP/WS, loopback only
          v
       robotd  (body truth, state, tasks, safety)
          |  USB CDC JSON Lines
          v
 ESP32-S3 firmware (pulse timing, watchdog, ENA)
          |
          v
 TB6600 drivers -> stepper motors, gimbal, pump

       modeld (slow visual/semantic inference)
          ^
          +-- asynchronous requests from robotd/agentd
```

## Non-negotiable invariants

- `robotd` is the sole authority for robot state and task state.
- The ESP32 is the sole authority for pulse generation, pin level, ENA timing,
  and local watchdog stop.
- Slow inference never sits in the motor control loop.
- `stop` is callable without the agent, is idempotent, and preempts normal work.
- Every externally visible mutation is declared in the owning OpenAPI contract.
- Physical actions are not retried blindly; an unknown outcome is reported as
  unknown and reconciled before another command.
- Hardware controls such as raw GPIO/PWM are not projected into the agent tool
  surface.
- Real hardware access is disabled in phase one.

## Current implementation state

This section is the repository-level status statement. Per-capability detail
lives in `robotd/src/robotd/capabilities.py` and in the test suites.

Implemented today:

- `robotd`: configuration and startup validation, the event-merging kernel,
  single-authority state, task table with exclusivity, the capability registry
  and approval gate, lifecycle/shutdown, loopback-only HTTP/WS transport with
  event cursors and resync, and speech listen/speak through the resident audio
  bridge (speech availability depends on that bridge, not on process startup).
- `agentd`: contract and event allow-list, SQLite persistence, task lifecycle
  and idempotency, event cursors plus WS push, model configuration with
  revisions, write-only credentials and verification, body observation with
  degradation, stop bypass, and the read-only daily UI (A03–A09, A15–A18).

Staged work, reported as `E_UNAVAILABLE` instead of pretended success:

- `robotd`: board-side serial adaptation and calibration, control isolation
  (ADR-0010 is still proposed), perception/follow (R15–R17), and real-hardware
  timing validation.
- `agentd`: managed Harness lifecycle (A10) and voice approval / one-time
  authorization (A13). A11/A12/A14 therefore stop at the orchestration skeleton
  plus stop bypass.

Source, tests, and the capability registry are the authority for current
capability; design documents do not upgrade planned features into implemented
ones.
