# @agentkitforge/auto-core

Core engine for **AgentKitAuto** — hosted, autonomous Agent Kit runs.

This package is **private / unpublished** for now.

## What it is (Phase A)

Phase A is **on-demand, fire-and-forget, run-to-completion** autonomous
execution. Given a kit, a standing approval, and a **required** per-run budget,
it drives a kit to completion with **no human in the per-step loop**, records
lifecycle + audit + result, and enforces a budget cap and a kill-switch.

It **reuses [`@agentkitforge/gateway-core`](../agentkitgateway-core)** for the
chat/tool engine and billing — Auto does **not** re-implement the model call,
the pricing table, or the credit ledger. Each model turn runs through
gateway-core's `runManagedTurn` (two-phase credit hold → provider call → settle
the actual metered cost via `computeDebitCents`). Auto adds only the autonomous
loop and its guards.

### The key difference vs the interactive gateway

The interactive gateway loop confirms **every** tool call with a human. Auto has
**no per-call confirm**. Instead, a **standing approval** pre-authorizes runs of
a specific kit, and its `toolAllowlist` **is** the consent. The non-interactive,
policy-gated **sandbox executor** is the only "hands":

- Supports **only** `read_file`, `list_dir`, `write_file`, all confined to a
  per-run **ephemeral workspace** (every path canonicalized + confined to the
  workspace root; traversal/absolute/symlink escape rejected).
- A call is permitted only if its tool is in
  `kit tools ∩ approval.toolAllowlist ∩ {read_file, list_dir, write_file}`.
- **There is no autonomous shell.** `run_command` and any network tool are
  hard-rejected (returned as an error result, never executed, never thrown).
- Every call is appended to the run's audit log.

### Safety invariants

- A run is permitted **only** if a matching, non-revoked `AutoApproval` exists
  for the kit **and** `run.budgetCents <= approval.maxBudgetCents`.
- **Budget is required per run** (no default). The driver checks
  `spentCents < budgetCents` before each turn and stops with status
  `budget_exceeded` once spend reaches the budget.
- **Kill-switch:** `requestCancel(runId)` stops the run between turns (status
  `canceled`).
- **Network policy** is `deny_all` in Phase A (egress deferred to Phase C; the
  field exists now for contract stability).

## Architecture

Mirrors gateway-core / market-core: a runtime- and cloud-agnostic core behind
ports, with two interchangeable adapters.

```
src/core/
  types.ts            AutoRun, AutoApproval, KitRef, statuses (zod schemas)
  ports.ts            AutoRunRepository, AutoApprovalRepository, WorkspaceStore
  sandbox-executor.ts makeSandboxExecutor — the non-interactive policy-gated hands
  run-driver.ts       runAutoRun — autonomous loop + budget cap + kill-switch (reuses gateway-core)
  fs-workspace.ts     FsWorkspaceStore — shared path-confined local-disk workspace
  deps.ts             makeAutoDeps({ backend })
src/adapters/
  aws/                DynamoDB repos (AutoRuns, AutoApprovals) + tmp-dir workspace
  selfhost/           Postgres repos + local-disk (k8s PV) workspace + schema.sql
src/entrypoints/
  worker.ts           processAutoRun(runId, deps) — Fargate task / k8s Job / dev runner
```

`makeAutoDeps({ backend })` selects the storage layer. The chat/billing deps
(`ChatProvider`, `CreditLedgerRepository`) come from gateway-core and are
injected into `processAutoRun` / `runAutoRun` at the composition root — Auto
never owns billing.

### Workspace backing (Phase A)

Both adapters back the per-run workspace with the **local disk**
(`FsWorkspaceStore`): the AWS adapter uses an OS tmp dir on the (short-lived)
task filesystem; the self-host adapter uses a directory on a k8s PersistentVolume.
A durable S3-prefix-backed `WorkspaceStore` is a Phase B/C concern and slots in
behind the same port without touching the driver.

## Usage sketch

```ts
import { makeAutoDeps, processAutoRun } from "@agentkitforge/auto-core";

const storage = makeAutoDeps({ backend: "selfhost", pool });

const result = await processAutoRun(runId, {
  storage,
  chatProvider,           // from @agentkitforge/gateway-core (platform key)
  ledger,                 // from @agentkitforge/gateway-core (credit ledger)
  resolveKitContext,      // injected: returns { systemPrompt, tools, toolNames }
  now: () => new Date().toISOString(),
});
```

## Development

```bash
npm install
npm test         # vitest; dynamodb-local suite is gated on DYNAMODB_ENDPOINT
npm run build
npm run typecheck
```

Repository tests run dual-backend: the Postgres adapter against **pg-mem**
(unconditional), the DynamoDB adapter against **dynamodb-local** (skipped unless
`DYNAMODB_ENDPOINT` is set), mirroring gateway-core / market-core.

## Self-hosted deployment — result delivery (email)

Self-hosted Auto supports **SMTP email delivery** for run-result notifications
(Phase D). Configure it via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | yes (to enable) | — | SMTP server hostname |
| `SMTP_FROM` | yes (to enable) | — | Envelope / From address (must be authorized by the relay) |
| `SMTP_PORT` | no | `587` | SMTP port |
| `SMTP_SECURE` | no | `false` | `"true"` to use TLS from the start (port 465); otherwise STARTTLS |
| `SMTP_USER` | no | — | SMTP auth username |
| `SMTP_PASS` | no | — | SMTP auth password |

**Inert when unconfigured:** if `SMTP_HOST` or `SMTP_FROM` is unset, the sender
returns `{ status: "skipped" }` and logs a warning once — runs are never affected
and webhook delivery continues to work. SMTP errors are caught and returned as
`{ status: "failed" }`; they are non-fatal.

Example (STARTTLS with authentication):
```
SMTP_HOST=smtp.mailrelay.example.com
SMTP_PORT=587
SMTP_USER=automailer@example.com
SMTP_PASS=supersecret
SMTP_FROM=auto-noreply@example.com
```

The hosted (AWS) backend uses SES (`SES_SENDER` env var) instead; the SMTP
adapter is selfhost-only.

## Deferred to later phases

- **Phase B — scheduling:** cron / recurring runs.
- **Phase C — triggers + egress + inputs:** event triggers, **network egress**
  (the `deny_all` policy relaxes here), richer per-run user inputs.
- **Phase D — isolation + delivery + self-host:** hardened container isolation
  for the sandbox, result **delivery** (email / webhook), and full self-hosted
  AgentKitAuto.

All of these are out of scope for Phase A.
