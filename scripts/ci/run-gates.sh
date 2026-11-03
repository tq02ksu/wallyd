#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

printf '[1/5] repository structure and secret scan\n'
bash scripts/ci/validate-baseline.sh

printf '[2/5] generated contracts match sources\n'
npm run contract:check

printf '[3/5] Python robot runtime checks and tests\n'
(
  cd robotd
  uv run --locked ruff format --check src tests
  uv run --locked ruff check src tests
  uv run --locked python -m pytest -q
)

printf '[4/5] TypeScript agent runtime checks\n'
npm --prefix agentd test

printf '[5/5] diff hygiene\n'
git diff --check
printf 'All WALLY gates passed\n'
