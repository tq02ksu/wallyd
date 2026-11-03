# Device Protocol

The current design target is the USB CDC JSON-Lines protocol documented in
[communication-protocol.md](../communication-protocol.md), with the
MicroPython implementation in
[firmware/robot_server_v2.py](../firmware/robot_server_v2.py).

Key protocol properties:

- one JSON object per line, with request IDs echoed by the board;
- a versioned `hello` handshake reporting firmware, capabilities, limits, and
  calibration metadata;
- continuous `velocity` messages while motion is intended, with a board-side
  watchdog stop;
- idempotent, preempting `stop` that remains available without the agent;
- explicit errors for busy, range, state, firmware mismatch, and hardware faults;
- no silent success when a requested capability is unavailable.

TB6600 inputs in the adopted hardware revision require a low-or-high-impedance
two-state discipline. Driving them to 3.3 V is not a safe inactive state. See
[stepper-wiring.md](../stepper-wiring.md).

The wire protocol contract is not yet complete. Do not treat planned commands as
implemented until firmware, robotd, and contract tests agree.
