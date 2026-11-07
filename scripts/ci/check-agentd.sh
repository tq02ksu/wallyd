#!/usr/bin/env bash
# TypeScript brain: typecheck plus unit and contract tests. Dependencies must be installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

printf '[agentd] typecheck, unit, and contract tests\n'
npm --prefix agentd test
