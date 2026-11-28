# Device Protocol

The transport target is USB CDC JSON-Lines. Its semantic boundary is documented
in the canonical
[communication design](https://github.com/tq02ksu/persona/blob/main/projects/wallyd/design/communication-protocol.md),
with the MicroPython implementation in
[firmware/robot_server_v2.py](../../firmware/robot_server_v2.py).

Key protocol properties:

- one JSON object per line, with request IDs echoed by the board;
- a versioned `hello` handshake reporting firmware, capabilities, limits, and
  calibration metadata;
- continuous `velocity` messages while motion is intended, with a board-side
  watchdog stop;
- idempotent, preempting `stop` that remains available without the agent; a
  successful write is only `requested`, and a stop without a request id has no
  matching board reply, so it must never become `confirmed`;
- explicit errors for busy, range, state, firmware mismatch, and hardware faults;
- no silent success when a requested capability is unavailable.
- target motion fields are explicitly device-facing steps and step rates;
  user-facing `distance_m` / `speed_mps` are converted in the robotd Device
  Adapter. Mixed units in the current v2 prototype must not become the final
  contract.

TB6600 inputs in the adopted hardware revision require a low-or-high-impedance
two-state discipline. Driving them to 3.3 V is not a safe inactive state. See
[stepper-wiring.md](../stepper-wiring.md).

The wire protocol contract is not yet complete. Do not treat planned commands as
implemented until firmware, robotd, and contract tests agree.
