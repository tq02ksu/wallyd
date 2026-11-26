# Robot API

The machine-readable contracts remain the source of truth for implemented
transport shapes:

- [robotd OpenAPI](../../contracts/openapi.yaml)
- [agentd OpenAPI](../../agentd/contracts/openapi.yaml)
- [robotd events](../../contracts/events.json)
- [agentd events](../../agentd/contracts/events.json)

Generated clients and machine schemas under `contracts/generated/` and
`agentd/contracts/generated/` must stay in sync with their owning contracts;
manual edits to generated files are rejected by the contract gate.

Only explicitly curated semantic robot capabilities belong on the agent-facing
surface. The target is a narrow `robot-mcp` facade containing Action-style task
tools, read-only Service queries, and filtered State/Event. Serial ports, GPIO,
PWM, TB6600 timing, ENA state, calibration writes, firmware flashing, and
internal module RPCs must never become agent tools.

`robotd` exclusively owns microphone/live audio, AEC/VAD, ASR, Utterance events,
Safety Word, TTS playback and deterministic short-command routing. Safety Word
runs in parallel with ASR and does not wait for `speech.final`. Simple known
commands stay local. Only complex text/context requests are forwarded to agentd;
baseline requests contain no live audio or microphone PCM. Codex audio capability
availability is not a WALLY dependency and Codex never owns the microphone.

The existing OpenAPI-derived tool generator is an implementation aid, not a rule
that every route or internal module becomes an agent tool. New tools must be
added to the curated schema deliberately.

Normal robot tasks do not use per-action human approval or one-time
authorization. `stop` is an independent Safety Stop path. Development-time
hardware operation still requires explicit human authorization under
`AGENTS.md`.

The canonical task semantics are:

```text
submitTask(goal) -> TaskHandle
getTask(task_id)
onTaskFeedback(task_id, callback)
waitTask(task_id) -> TaskResult
cancelTask(task_id)
```

`TaskResult` separates lifecycle, `goal_achieved`, and completion evidence.
Complete architecture and ADR-0014/0016/0019 live in
[`projects/wallyd`](https://github.com/tq02ksu/persona/tree/main/projects/wallyd/design).

No new API is considered available until the owning machine-readable contract,
the curated agent tool schema (when exposed to Codex), implementation behavior,
events, and generated types agree.
