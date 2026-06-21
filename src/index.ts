/**
 * @agentkitforge/auto-core public API surface (Phase A).
 *
 * AgentKitAuto: hosted, on-demand, run-to-completion autonomous Agent Kit runs.
 * Reuses @agentkitforge/gateway-core's engine (managed-turn billing + pricing);
 * adds a non-interactive policy-gated sandbox executor (the hands), standing
 * approvals, a REQUIRED per-run budget cap, a kill-switch, lifecycle + audit,
 * and AWS + self-host adapters.
 *
 * The worker entrypoint is also available as a subpath export:
 *   @agentkitforge/auto-core/entrypoints/worker
 */

// ---- Core types ----------------------------------------------------------
export type {
  AuditEntry,
  ApprovalScope,
  AutoApproval,
  AutoRun,
  AutoRunInput,
  AutoRunInputFile,
  AutoRunInputFileRef,
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  AutoWebhook,
  CreateApprovalInput,
  CreateRunInput,
  CreateScheduleInput,
  CreateWebhookInput,
  DeliveryChannelOutcome,
  DeliveryChannelStatus,
  DeliveryConfig,
  DeliveryOutcome,
  DeliveryWebhook,
  InferenceMode,
  KitRef,
  NetworkPolicy,
  RunTrigger,
  UpdateScheduleInput,
  WebhookFireResult,
  WorkspaceFileEntry,
} from "./core/types.js";
export {
  autoApprovalSchema,
  autoRunInputFileRefSchema,
  autoRunInputFileSchema,
  autoRunInputSchema,
  autoRunStatusSchema,
  autoScheduleSchema,
  autoWebhookSchema,
  deliveryConfigSchema,
  deliveryWebhookSchema,
  DENY_ALL_NETWORK_POLICY,
  kitRefKey,
  kitRefSchema,
  networkPolicySchema,
  normalizeNetworkPolicy,
  validateDeliveryConfig,
} from "./core/types.js";

// ---- Ports ---------------------------------------------------------------
export type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  AutoWebhookRepository,
  ConfigProvider,
  EmailSender,
  EmailSendResult,
  InputStore,
  OutboundEmail,
  ScheduleRunResult,
  StagedInputFile,
  WorkspaceStore,
} from "./core/ports.js";

// ---- Cron utils (Phase B) ------------------------------------------------
export { nextFireAfter, parseCron, validateCron, CronParseError } from "./core/cron.js";
export type { ParsedCron } from "./core/cron.js";

// ---- Schedule runner (Phase B) -------------------------------------------
export { runDueSchedules } from "./core/schedule-runner.js";
export type {
  CreateAndDispatch,
  RunDueSchedulesArgs,
  RunDueSchedulesDeps,
  ScheduleSweepError,
  ScheduleSweepSummary,
} from "./core/schedule-runner.js";

// ---- Webhook triggers (Phase C) ------------------------------------------
export { consumeWebhook, WebhookError } from "./core/webhook-runner.js";
export type {
  ConsumeWebhookArgs,
  CreateAndDispatchWebhookRun,
  WebhookErrorReason,
} from "./core/webhook-runner.js";
export {
  generateWebhookSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
} from "./core/webhook-secret.js";

// ---- Network egress (Phase C http_fetch) ---------------------------------
export {
  guardedHttpFetch,
  hostMatchesAllowlist,
  isBlockedIp,
  HttpFetchError,
} from "./core/http-fetch.js";
export type {
  DnsResolver,
  FetchFn,
  HttpFetchArgs,
  HttpFetchOptions,
  HttpFetchResult,
} from "./core/http-fetch.js";

// ---- Result delivery (Phase D) -------------------------------------------
export {
  buildWebhookPayload,
  deliverResult,
  signWebhookBody,
} from "./core/delivery.js";
export type {
  DeliverResultArgs,
  DeliverResultDeps,
  DeliveryResultInput,
  DeliveryWebhookPayload,
} from "./core/delivery.js";

// ---- User-provided inputs (Phase C) --------------------------------------
export {
  confineInputPath,
  INPUTS_SUBDIR,
  InputPathError,
  LocalInputStore,
} from "./core/input-store.js";

// ---- Sandbox executor (the hands) ---------------------------------------
export {
  makeSandboxExecutor,
  SANDBOX_FILE_TOOLS,
  SANDBOX_TOOLS,
} from "./core/sandbox-executor.js";
export type {
  MakeSandboxExecutorArgs,
  SandboxExecutor,
  SandboxToolName,
  SandboxToolResult,
  SandboxToolUse,
} from "./core/sandbox-executor.js";

// ---- Run driver ----------------------------------------------------------
export { runAutoRun } from "./core/run-driver.js";
export type {
  RunAutoRunArgs,
  RunAutoRunDeps,
  RunAutoRunResult,
} from "./core/run-driver.js";

// ---- Workspace (shared filesystem impl) ---------------------------------
export { FsWorkspaceStore, WorkspaceEscapeError } from "./core/fs-workspace.js";
export type { FsWorkspaceStoreOptions } from "./core/fs-workspace.js";

// ---- Deps factory --------------------------------------------------------
export { makeAutoDeps } from "./core/deps.js";
export type { AutoBackend, MakeAutoDepsOptions } from "./core/deps.js";

// ---- Worker entrypoint ---------------------------------------------------
export { processAutoRun, ApprovalDeniedError } from "./entrypoints/worker.js";
export type {
  ProcessAutoRunDeps,
  ResolveKitContext,
  ResolvedKitContext,
} from "./entrypoints/worker.js";

// ---- HTTP kit-context resolver (Fargate worker) -------------------------
export {
  fetchResolveContext,
  toResolveKitContext,
} from "./core/http-resolve-context.js";
export type {
  FetchResolveContextArgs,
  ResolveContextResponse,
} from "./core/http-resolve-context.js";

// ---- AWS adapter ---------------------------------------------------------
export {
  AUTO_TABLE_ENV_VARS,
  awsClientEnv,
  createDynamoDBDocumentClient,
  DynamoAutoApprovalRepository,
  DynamoAutoRunRepository,
  DynamoAutoScheduleRepository,
  DynamoAutoWebhookRepository,
  loadAutoDynamoTableNames,
  makeAwsAutoDeps,
  s3ClientEnv,
} from "./adapters/aws/index.js";
export type {
  AutoDynamoTableNames,
  MakeAwsAutoDepsOptions,
} from "./adapters/aws/index.js";
export { inputObjectKey, S3InputStore } from "./adapters/aws/s3-input-store.js";
export type { S3InputStoreOptions } from "./adapters/aws/s3-input-store.js";
export { makeSesEmailSender } from "./adapters/aws/ses-email-sender.js";
export type { SesEmailSenderOptions } from "./adapters/aws/ses-email-sender.js";

// ---- Self-host adapter ---------------------------------------------------
export {
  AUTO_SCHEMA_SQL,
  ensureAutoSchema,
  makeSelfHostAutoDeps,
  PostgresAutoApprovalRepository,
  PostgresAutoRunRepository,
  PostgresAutoScheduleRepository,
  PostgresAutoWebhookRepository,
} from "./adapters/selfhost/postgres.js";
export type {
  MakeSelfHostAutoDepsOptions,
  PgPool,
} from "./adapters/selfhost/postgres.js";
export { makeSelfHostEmailSender } from "./adapters/selfhost/email-sender.js";
export { makeFreeCreditLedger } from "./adapters/selfhost/free-ledger.js";
