#!/usr/bin/env bash
# Python body runtime: format, lint, and tests. Dependencies must be installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/robotd"

printf '[robotd] ruff format\n'
uv run --locked ruff format --check src tests

printf '[robotd] ruff check\n'
uv run --locked ruff check src tests

printf '[robotd] pytest\n'
uv run --locked python -m pytest -q
