---
tracker:
  kind: github
  provider:
    repo: tq02ksu/wallyd
    token: $GITHUB_TOKEN
    api_url: https://api.github.com
  required_labels:
    - ai-ready
  active_states:
    - open
  terminal_states:
    - closed
workspace:
  root: /data/agent-dev/workspaces
hooks:
  timeout_ms: 600000
  after_create: |
    /data/agent-dev/bin/symphony-workspace-create "$PWD" "{{ issue.identifier }}"
  after_run: |
    /data/agent-dev/bin/symphony-publish "$PWD"
  before_remove: |
    /data/agent-dev/bin/symphony-workspace-remove "$PWD"
agent:
  max_concurrent_agents: 2
  max_turns: 3
codex:
  command: "env HOME=/data/agent-dev CODEX_HOME=/data/agent-dev/codex-home PATH=/data/agent-dev/bin:/usr/local/bin:/usr/bin:/bin /data/agent-dev/bin/codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - /data/agent-dev/workspaces
    networkAccess: false
server:
  port: 4000
---

You are implementing GitHub issue {{ issue.identifier }} for WALLY.

Title: {{ issue.title }}

Issue body:

{{ issue.description }}

Follow `AGENTS.md` exactly. Work only in the current issue worktree and on the
current `ai/GH-*` branch. Start by querying ai-memory for relevant verified
project context. Use GitNexus for code search and impact analysis when it is
available and licensed for this project. Read `docs/ai-coding-loop.md` before
planning and treat the issue's acceptance criteria as the task contract.

For contract changes, update the owning OpenAPI/event contract first, regenerate
derived artifacts, then update tests and implementation. For behavioral changes,
write or update a failing test before implementation. Use only the ECC
allowlist: TDD workflow, code review, build/error repair, security review, and
verification loop.

Implement and test the requested change. Do not push, create a pull request,
merge anything, modify `main`, or operate real hardware. Commit only after the
relevant tests pass. The trusted host-side `after_run` hook will push the
branch and open the pull request for human review.

If work cannot safely continue, create `.symphony/blocked` with a concise
reason and do not commit or publish incomplete work.
