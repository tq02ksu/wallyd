#!/usr/bin/env bash
# Python gates: format/lint/tests for robotd, plus ruff over the Python entry
# points outside it. Dependencies must be installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/robotd"

printf '[robotd] ruff format\n'
uv run --locked ruff format --check src tests

printf '[robotd] ruff check\n'
uv run --locked ruff check src tests

# Python outside the `robotd` package (`src/modeld.py`, `src/serial-bridge.py`,
# `eval/`, and the board-side `firmware/*.py` helpers) is only syntax-checked by
# the static lane. Lint it with the same ruff config so it does not drift
# unchecked. This is static analysis only; nothing is flashed or executed.
printf '[python] ruff check src eval firmware\n'
uv run --locked ruff check --config pyproject.toml ../src ../eval ../firmware

printf '[robotd] pytest\n'
uv run --locked python -m pytest -q
