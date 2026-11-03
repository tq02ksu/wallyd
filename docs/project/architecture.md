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

The repository now contains both the Python `robotd` foundation and the
TypeScript `agentd` persistence/orchestration foundation from the reference
project. Transport, serial adaptation, managed Harness lifecycle, voice approval,
navigation, SLAM, and real-hardware validation remain staged work. The source
and tests are the authority for current capability; design documents do not
upgrade planned features into implemented ones.
