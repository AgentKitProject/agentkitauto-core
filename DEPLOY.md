# AgentKitAuto — Hosted Execution Deploy Runbook (Phase A)

The hosted execution slice runs each Auto run as a **one-shot AWS Fargate task**.
The web app (`agentkitforge-web`) creates the queued run and dispatches it via ECS
`RunTask`; the Fargate worker (this package's `run-task` entrypoint) executes the
run end-to-end with `processAutoRun`, calling back into the web app's internal
`resolve-context` endpoint for the kit prompt + BYO provider config.

> **Never echo secrets.** `ANTHROPIC_API_KEY`, `AUTO_WORKER_SERVICE_KEY`, and
> `MARKET_SERVICE_KEY` must not be printed to logs or pasted into shared
> terminals. Generate each service key with `openssl rand -hex 32`; store them
> only in the ECS task def (or SSM) and the relevant Amplify env.

## Components

| Piece | Where | What |
|---|---|---|
| Worker image | this repo (`Dockerfile`) | `node` image running `dist/entrypoints/run-task.js`; reads `RUN_ID` + AWS task role + `WEB_FORGE_INTERNAL_URL`/`AUTO_WORKER_SERVICE_KEY`. |
| CDK infra | `agentkitforge-web/infra` | `AutoRuns`/`AutoApprovals` tables, ECR repo `agentkit-auto-worker`, public-only VPC (no NAT), SG (443+DNS egress), ECS cluster, task + execution roles, task def, SSR-user grants. |
| Dispatcher | `agentkitforge-web/server/core/auto-fargate-dispatcher.ts` | ECS `RunTask` (FARGATE, public IP, `RUN_ID` override). Selected when `AUTO_DISPATCH=fargate` + `KITSTORE_BACKEND=aws`. |
| Internal endpoint | `agentkitforge-web/app/api/internal/auto/resolve-context/route.ts` | Service-key-only; returns prompt/tools/model/inferenceMode/byoProvider to the worker. |

## Ordered deploy

### (pre-a) Publish and repin `@agentkitforge/contracts@0.13.0` — prerequisite

`@agentkitforge/contracts` was bumped to **0.13.0** to introduce the
`marketServiceRoutes`/`marketServiceAuthHeader` seam (web-forge ↔ market-app
protected-kit service trust). Both consumers currently point at
`file:../agentkitproject-contracts` for local verification; Amplify cannot
resolve a `file:` dep, so this step must land before any Amplify build.

1. **Publish `@agentkitforge/contracts@0.13.0` to public npm** using the
   repo's normal release-please + `publish-npm` GitHub-hosted runner flow.
   (Publishing must run on a GitHub-hosted runner; provenance is rejected on
   self-hosted ARC runners.)

2. **Repin both consumers** from `file:../agentkitproject-contracts` to
   `^0.13.0`:
   - `agentkitmarket-app/package.json` — was `^0.12.0`, bump to `^0.13.0`
   - `agentkitforge-web/package.json` — contracts dep is **new** in this
     slice; add `"@agentkitforge/contracts": "^0.13.0"`

3. Run `npm install` in both repos to refresh their lockfiles, then commit
   the `package.json` + `package-lock.json` changes.

Amplify builds fail if this step is skipped.

### (a) AWS SSO login
```bash
aws sso login --profile AdministratorAccess-609086950193
export AWS_PROFILE=AdministratorAccess-609086950193
```

### (b) Deploy the web CDK stack (tables / ECR / cluster / roles / networking)
```bash
cd agentkitforge-web/infra
npm ci
npm run synth        # credless sanity check (optional)
# Pass the markup/url + secrets via CDK context. Do NOT commit secret values.
npx cdk deploy \
  -c webForgeInternalUrl=https://webapp.forge.agentkitproject.com \
  -c anthropicApiKey="$ANTHROPIC_API_KEY" \
  -c autoWorkerServiceKey="$AUTO_WORKER_SERVICE_KEY"
```
Record the CfnOutputs: `AUTO_RUNS_TABLE`, `AUTO_APPROVALS_TABLE`, `AutoEcsCluster`
(→ `AUTO_ECS_CLUSTER`), `AutoEcsTaskDef` (→ `AUTO_ECS_TASK_DEF`, the family),
`AutoEcsSubnetIds` (→ `AUTO_ECS_SUBNET_IDS`), `AutoEcsSecurityGroupId`
(→ `AUTO_ECS_SECURITY_GROUP_ID`), `AutoWorkerRepoUri` (the ECR repo).

> The CDK **references** the out-of-band SSR IAM user `agentkitforge-web-ssr` and
> the `GatewayCredit*` tables by name (override via `-c ssrUserName=...` /
> `-c gatewayCreditAccountsTable=...` etc. if the names differ). It does not
> create them.

### (c) Build + push the worker image, point the task def at it
The image depends on the sibling `agentkitgateway-core` repo (a `file:` dep), so
the **Docker build context is the parent workspace dir**, not this repo:
```bash
cd <workspaceRoot>          # the dir containing agentkitauto-core/ + agentkitgateway-core/
ECR_URI=<AutoWorkerRepoUri CfnOutput>   # e.g. 609086950193.dkr.ecr.us-east-1.amazonaws.com/agentkit-auto-worker
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"
docker build -f agentkitauto-core/Dockerfile -t "$ECR_URI:latest" .
docker push "$ECR_URI:latest"
```
The CDK task def references the `:latest` tag, so re-running a task after a push
picks up the new image. (For immutable deploys, push a digest/sha tag and register
a new task-def revision pointing at it, then update `AUTO_ECS_TASK_DEF`.)

### (d) Set the new Amplify env vars (web app)
In the `agentkitforge-web` Amplify app environment, add (these are baked into
`.env.production` by `amplify.yml`):
```
AUTO_DISPATCH=fargate
AUTO_ECS_CLUSTER=<AutoEcsCluster>
AUTO_ECS_TASK_DEF=<AutoEcsTaskDef family>
AUTO_ECS_SUBNET_IDS=<AutoEcsSubnetIds csv>
AUTO_ECS_SECURITY_GROUP_ID=<AutoEcsSecurityGroupId>
AUTO_WORKER_SERVICE_KEY=<generated; SAME value as the task def / SSM>
WEB_FORGE_INTERNAL_URL=https://webapp.forge.agentkitproject.com
MARKET_SERVICE_KEY=<generated; SAME value as set in agentkitmarket-app below>
```
`KITSTORE_BACKEND` must already be `aws` for the Fargate dispatcher to engage.
The SSR IAM user's keys (`FORGE_AWS_*`) must already be present and now carry the
`ecs:RunTask` + `iam:PassRole` + AutoRuns/AutoApprovals grants from step (b).

Also set in the **`agentkitmarket-app`** Amplify environment (same value):
```
MARKET_SERVICE_KEY=<same secret as above>
```

**`MARKET_SERVICE_KEY` — what it is and what it is not:**
- Authorizes the web-forge→market-app server-to-service call for
  protected/paid kit licensed-package resolution in hosted Auto runs. Both
  sides must hold the identical value or the request is rejected with 403.
- Generate it like the other service keys: `openssl rand -hex 32`
- **Distinct from `AUTO_WORKER_SERVICE_KEY`** (worker→web-forge internal
  channel). The Fargate worker holds `AUTO_WORKER_SERVICE_KEY` only; it
  NEVER holds `MARKET_SERVICE_KEY` and NEVER calls Market directly.
- Server-only — never ship it to browser bundles, Forge clients, or the
  worker task definition.

> Do **not** echo either service key into build logs. Set them through the
> Amplify console (or `aws amplify update-app --environment-variables`) directly.

### (e) Redeploy Amplify
Trigger a new Amplify build (push to the tracked branch or "Redeploy this
version") so the new env vars land in `.env.production`.

## Verify
- Start an Auto run from the hosted web app; confirm an ECS task launches
  (`aws ecs list-tasks --cluster <AUTO_ECS_CLUSTER>`), the task reaches the
  internal endpoint (no 401/503), and the run record transitions
  `queued → running → succeeded/failed`. The worker logs only
  `Auto run <id> finished: <status>` — never the prompt.

## Phase B follow-ups (flagged, not in this slice)
- Move `ANTHROPIC_API_KEY` + `AUTO_WORKER_SERVICE_KEY` from plain task-def env to
  Secrets Manager / SSM SecureString (`ecs.Secret.fromSsmParameter`).
- Protected/paid Market kits over the worker resolve path: **implemented** —
  web-forge resolves them via `MARKET_SERVICE_KEY` (server-to-service call to
  market-app) and hands the prompt to the worker over the existing internal
  `AUTO_WORKER_SERVICE_KEY` channel. Deploy requires the `MARKET_SERVICE_KEY`
  env var on both Amplify apps (see step d).
- S3-backed run workspaces (Phase A uses local ephemeral Fargate storage).
