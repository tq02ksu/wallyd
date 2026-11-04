#!/usr/bin/env bash
# Repository hygiene, source syntax, and generated-contract parity.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

printf '[static] required files and secret scan\n'
bash scripts/ci/validate-baseline.sh

printf '[static] source syntax (Node, shell, JSON, YAML)\n'
npm run lint --silent

printf '[static] generated contracts match sources\n'
npm run contract:check
