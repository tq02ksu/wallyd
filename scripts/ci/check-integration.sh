#!/usr/bin/env bash
# Cross-process simulation: start a real robotd simulator and exercise the
# agentd client against it over loopback HTTP. No hardware is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PORT="${ROBOTD_TEST_PORT:-8799}"
export ROBOTD_URL="http://127.0.0.1:${PORT}"
LOG_DIR="$ROOT/work/ci"
LOG_FILE="$LOG_DIR/robotd-sim-${PORT}.log"
mkdir -p "$LOG_DIR"
: > "$LOG_FILE"

PYTHONPATH=robotd/src robotd/.venv/bin/python -m robotd --sim --http "$PORT" serve >"$LOG_FILE" 2>&1 &
robotd_pid=$!

cleanup() {
  status=$?
  if kill -0 "$robotd_pid" 2>/dev/null; then
    kill "$robotd_pid" 2>/dev/null || true
    wait "$robotd_pid" 2>/dev/null || true
  fi
  # A failing lane is easiest to diagnose from the server side of the same run:
  # `test:live` only reports what the client saw. Every failure path exits
  # non-zero, so one place can dump the log without repeating it per branch.
  if [[ "$status" -ne 0 && -s "$LOG_FILE" ]]; then
    printf 'robotd sim log (%s):\n' "$LOG_FILE" >&2
    cat "$LOG_FILE" >&2
  fi
}
trap cleanup EXIT

printf '[integration] waiting for robotd sim on %s\n' "$ROBOTD_URL"
ready=0
for _ in $(seq 1 150); do
  if curl -fsS "$ROBOTD_URL/v1/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$robotd_pid" 2>/dev/null; then
    printf 'robotd sim exited during startup\n' >&2
    exit 1
  fi
  sleep 0.2
done
if [[ "$ready" -ne 1 ]]; then
  printf 'robotd sim did not become ready\n' >&2
  exit 1
fi

printf '[integration] agentd client against robotd sim\n'
npm --prefix agentd run test:live

printf '[integration] TypeScript-issued approval credential accepted by robotd Python verifier\n'
ROBOTD_PYTHON="$ROOT/robotd/.venv/bin/python" node --experimental-strip-types agentd/tests/integration/approval-cross-check.mjs
