#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

required_files=(
  AGENTS.md
  WORKFLOW.md
  docs/architecture.md
  docs/ai-coding-loop.md
  docs/hardware-baseline.md
  docs/robot-api.md
  docs/device-protocol.md
  docs/engineering-decisions.md
  doc/architecture.md
  doc/communication-protocol.md
  contracts/openapi.yaml
  agentd/contracts/openapi.yaml
  robotd/pyproject.toml
  agentd/package.json
)

for file in "${required_files[@]}"; do
  test -s "$file" || {
    printf 'Required file is missing or empty: %s\n' "$file" >&2
    exit 1
  }
done

if git grep -n -E 'github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+|BEGIN (RSA |OPENSSH )?PRIVATE KEY' -- . ':!scripts/ci/validate-baseline.sh'; then
  printf 'Potential credential material detected in tracked files\n' >&2
  exit 1
fi

printf 'Baseline validation passed\n'

