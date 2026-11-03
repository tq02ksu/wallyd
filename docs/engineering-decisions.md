# Engineering Decisions

The complete robot decision log is [doc/decisions/README.md](../doc/decisions/README.md).

## WALLY delivery decisions

### ADR-001: GitHub is the task source of truth

Accepted. Issues and pull requests are authoritative; no second task system is
introduced.

### ADR-002: Human-reviewed pull requests only

Accepted. Automation may prepare and publish pull requests but must never merge,
approve, or close them.

### ADR-003: Isolated worktrees and concurrency limit

Accepted. Symphony creates one worktree per issue and runs at most two Codex
agents. The limit is a resource and reviewability control.

### ADR-004: Host-side GitHub publishing

Accepted. Codex commits locally. A trusted host hook pushes and opens the pull
request, keeping the Fine-grained GitHub Token out of the Codex child process and
out of repository content.

### ADR-005: No hardware access in phase one

Accepted. The first loop is software and simulation only. Real hardware needs a
separate authorization, safety, and test process.

### ADR-006: GitNexus requires licence approval

Pending. Official GitNexus is PolyForm Noncommercial 1.0.0 and must not be
enabled for WALLY until its use is accepted or commercial terms are obtained.

### ADR-007: Adopt the reference robot's layered architecture

Accepted. `robotd`, `agentd`, and `modeld` remain separate processes. The
contract, state-ownership, event-driven, timing, stop, and unknown-state rules
from the reference project are adopted with the code.

### ADR-008: Treat the development loop as a first-class harness

Accepted. Every `ai-ready` task must declare observable acceptance criteria and
test evidence; context comes from versioned docs/contracts and verified memory;
CI gates executable behavior. See [ai-coding-loop.md](ai-coding-loop.md).

