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

# Python entry points outside the robotd package (`src/modeld.py`,
# `src/serial-bridge.py`, `eval/`) are only syntax-checked by the static lane.
# Lint them with the same ruff config so they do not drift unchecked.
printf '[python] ruff check src eval\n'
uv run --locked ruff check --config pyproject.toml ../src ../eval

printf '[robotd] pytest\n'
uv run --locked python -m pytest -q
