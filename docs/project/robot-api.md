# Robot API

The versioned API contract is the source of truth:

- [robotd OpenAPI](../../contracts/openapi.yaml)
- [agentd OpenAPI](../../agentd/contracts/openapi.yaml)
- [robotd events](../../contracts/events.json)
- [agentd events](../../agentd/contracts/events.json)

Generated clients and tool schemas under `contracts/generated/` and
`agentd/contracts/generated/` must be regenerated with `npm run contract:all`;
manual edits are rejected by the contract gate.

Only semantic robot capabilities belong on the agent-facing surface. Serial
ports, GPIO, PWM, TB6600 timing, and ENA state are implementation details and
must not become agent tools. Physical actions require the approval semantics
defined by the owning contract.

No new API is considered available until all three gates pass: generated files
match contracts, implementations match routes/events, and TypeScript types match
generated types.
