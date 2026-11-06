#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

printf '[1/5] static checks\n'
bash scripts/ci/check-static.sh

printf '[2/5] Python robot runtime checks and tests\n'
bash scripts/ci/check-robotd.sh

printf '[3/5] TypeScript agent runtime checks and tests\n'
bash scripts/ci/check-agentd.sh

printf '[4/5] agentd -> robotd simulation integration\n'
bash scripts/ci/check-integration.sh

printf '[5/5] diff hygiene\n'
git diff --check
printf 'All WALLY gates passed\n'
