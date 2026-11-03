# AI Coding Loop and Harness

The harness turns a GitHub issue into a reviewable, evidence-bearing change. It
does not treat a model's final message as proof of completion.

## Loop

```text
issue contract
  -> context pack
  -> plan and risk classification
  -> red test / reproduction
  -> implementation
  -> review and security pass
  -> contract + test gates
  -> local commit
  -> trusted host publish
  -> pull request
  -> human decision
  -> durable memory update
```

## 1. Issue contract

Only open issues labeled `ai-ready` are eligible. The issue must state the
desired outcome, acceptance criteria, non-goals, affected interfaces, and a test
plan. Ambiguity, architecture conflict, or hardware access stops the task rather
than encouraging invention.

## 2. Context pack

The agent reads, in order:

1. `AGENTS.md` and `WORKFLOW.md`;
2. relevant architecture, hardware, protocol, and ADR documents;
3. the owning OpenAPI/event contract and generated types;
4. implementation and tests around the affected symbols;
5. verified project memory from ai-memory;
6. GitNexus graph context when licensed and enabled.

Memory is evidence, not policy. Current repository content and fresh test output
outrank remembered context.

## 3. Change discipline

Use `$tdd-workflow` for behavioral changes, `$build-error-resolver` for failed
builds, `$code-reviewer` for a fresh diff review, `$security-review` for risky
boundaries, and `$verification-loop` before commit. The broader ECC catalog is
not enabled by default.

Contract changes follow this order: contract -> generated artifacts -> tests ->
implementation. Public robot operations stay semantic; GPIO/PWM/serial controls
never enter the model tool surface.

## 4. Evidence

A task is publishable only when:

- the worktree is clean and the commit is on its `ai/GH-*` branch;
- every acceptance criterion maps to a test, simulation result, or documented
  inspection step;
- `npm run contract:check`, relevant Python/TypeScript tests, and the full
  offline gate pass;
- no secrets, credentials, unauthorized hardware operations, or unverified
  claims entered the diff;
- review findings are either fixed or documented as non-blocking risks.

The host publisher creates exactly one pull request per branch and never merges
it.

## 5. Harness boundaries

The software-delivery harness and the robot runtime share contracts and tests,
not process state. A Codex/Symphony failure must not disable robot `stop`.
Conversely, the robot's runtime `agentd` is not used as the software-development
orchestrator; GitHub and Symphony remain the development source of truth.

## 6. Continuous improvement

Only verified decisions, test-backed debugging conclusions, and reviewed
architecture choices may be stored in ai-memory. ECC may suggest reusable
workflows, but new global rules or hooks require a reviewed change. Repeated task
friction should become a test, repository instruction, or narrowly scoped skill,
not an ever-growing prompt.

