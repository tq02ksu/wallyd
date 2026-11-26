# Architecture

This is the one-page executable architecture summary for the `wallyd`
repository. The complete architecture and canonical ADRs live in
[`projects/wallyd`](https://github.com/tq02ksu/persona/tree/main/projects/wallyd/design).
This summary was reconciled against `fe10878` on 2026-11-26.

Source hierarchy:

1. complete architecture and decision rationale: `projects/wallyd`;
2. implementation scope: GitHub issues and pull requests;
3. implemented behavior: source code, tests, and machine-readable contracts;
4. roadmap progress: `projects/wallyd/roadmap/`.

## Runtime boundaries

```text
Autonomy Runtime: robotd
  live audio/AEC/VAD, parallel Safety Word, ASR, deterministic routing, RobotTask,
  ActionEpisode, RobotState, WorldModel, behavior, motion,
  resource arbitration, safety, devices
        ├─ Safety Word ──► local Safety Stop (never waits for speech.final)
        │
        └─ complex request ──► Cognitive Assistant: agentd + Codex
                               missions, sessions, open-ended planning
                               curated tools ──► robotd

Device Runtime: ESP32-S3
  pulse timing, direction, encoder input, watchdog, ENA

Model Service: modeld
  local inference only; no robot task or body authority
```

`robotd` exclusively owns microphone, live audio, AEC/VAD, ASR, Utterance and TTS
playback, and is the component container for the Autonomy Runtime. Safety Word
runs in parallel with normal ASR and does not wait for `speech.final`. agentd is
an optional attached cognitive processor and receives structured text/context
only. Codex may support audio inputs, but live audio is not part of the WALLY
baseline and Codex never owns the microphone. `robotd` is not the whole ROS graph;
WALLY borrows Action/Service/State semantics but does not adopt ROS 2, DDS,
rclpy, or Nav2 as a runtime dependency.

## Non-negotiable invariants

- `robotd` is the sole authority for RobotTask, ActionEpisode, RobotState,
  WorldModel, and safety decisions.
- `robotd` exclusively owns microphone/live audio/AEC/VAD, ASR output, Utterance
  events, Safety Word, and TTS playback. Safety Word runs in parallel with ASR
  and never waits for `speech.final`; simple known commands stay local.
- agentd receives structured text/context for complex requests; baseline calls
  contain no live audio or microphone PCM. Codex audio capability availability is
  not a WALLY dependency and Codex never owns the microphone.
- Codex/agentd may submit goals, observe, query, and request cancellation. They
  must not access GPIO, PWM, serial frames, calibration writes, firmware
  flashing, or device internals.
- `stop` is a local Safety Stop path. It does not wait for `speech.final`, Codex,
  network, a normal task queue, or human approval.
- `dispatched`, `board_ack`, and `motion.done` are different facts from physical
  completion.
- Module access is bounded by import/architecture tests. Device objects are
  constructed only by the composition root and injected through narrow ports.
- Runtime Guards validate parameters, current state, resource ownership, and the
  safety envelope at the execution boundary.
- Only one state store commits RobotState + RobotTask + ActionEpisode + event
  sequence atomically.
- The ESP32 owns pulse generation and the local watchdog. Host failure must not
  turn into a false success claim.
- No new internal module automatically becomes visible to Codex. Agent tools are
  explicitly curated.

## Autonomy Runtime components

- Runtime Foundation: composition, simplified lifecycle, event kernel, state
  store, clock/timers/bounded work.
- Autonomy Capabilities: perception, localization, world model, planning,
  behavior, motion.
- Execution Governance: Task Executive, Execution Resource Arbiter, Safety
  Monitor, Fault Routing.

`Task Executive` coordinates RobotTask lifecycle. `Execution Resource Arbiter`
owns logical resources such as `base_motion`, `gimbal`, and `audio_output`; it
is not ros2_control's hardware-interface `ResourceManager`. Safety Monitor has
stop/veto priority and does not own a second robot state.

## Agent-visible task interface

```text
submitTask(goal) -> TaskHandle {task_id}
getTask(task_id) -> RobotTask
onTaskFeedback(task_id, callback)
waitTask(task_id) -> TaskResult
cancelTask(task_id) -> CancellationRequest
```

`TaskHandle` is only a reference. Feedback is a projection. Cancellation is a
request decided by robotd. `TaskResult` separates:

```text
lifecycle: completed | failed | cancelled | interrupted
goal_achieved: true | false | null
evidence: board_reported | sensor_verified | unknown
```

Long movement tasks use explicit SI parameters such as `distance_m` and
`speed_mps`. Device adapters convert them to board steps/rates. A completed board
motion without sensor evidence is not `goal_achieved=true`.

## Tool and transport boundary

- Codex sees only a curated `robot-mcp` tool surface.
- robotd internal modules use typed Python interfaces/ports, not a generated HTTP
  projection of every module.
- UI and diagnostics use separate read-only or controlled maintenance interfaces.
- Skills and scripts guide usage; they are not security boundaries.
- Normal robot tasks do not use per-action Approval, Authorization, or caller
  credentials.

The development phase temporarily allows unrestricted Codex network access to
unblock the M0 loop. This is a known technical risk, not a completed security
design. It must be revisited before multi-user, unattended, or public deployment.

## Current implementation state

The repository overview is a status statement, not an architecture upgrade.
Per-capability truth remains in `robotd/src/robotd/capabilities.py` and tests.

Implemented today:

- `robotd`: configuration/startup validation, event-merging kernel,
  single-authority state, task table with exclusivity, capability registry,
  lifecycle/shutdown, loopback HTTP/WS transport with event cursors and resync,
  and speech listen/speak through the resident audio bridge.
- `agentd`: contract/event allow-list, SQLite persistence, task lifecycle and
  idempotency, event cursors plus WS push, model configuration, body observation,
  stop bypass, and the daily UI.

Not yet implemented or not validated:

- Action-style `submitTask` with RobotTask + ActionEpisode lifecycle;
- migration of Safety Word and deterministic routing from agentd into robotd's
  audio boundary, with Safety Word independent of `speech.final`;
- static module boundaries and Runtime Guard for the new architecture;
- serial/calibration/real-hardware validation in `main`;
- curated `robot-mcp` tool surface and removal of legacy broad HTTP projections;
- recovery/perception/localization/world model beyond existing experiments.

Current M0 acceptance, evidence rules, and the temporary network exception are in
[the roadmap and ADR-0016/0017](https://github.com/tq02ksu/persona/tree/main/projects/wallyd).
