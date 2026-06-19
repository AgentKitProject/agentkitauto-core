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
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  CreateApprovalInput,
  CreateRunInput,
  CreateScheduleInput,
  InferenceMode,
  KitRef,
  NetworkPolicy,
  RunTrigger,
  UpdateScheduleInput,
  WorkspaceFileEntry,
} from "./core/types.js";
export {
  autoApprovalSchema,
  autoRunInputFileSchema,
  autoRunInputSchema,
  autoRunStatusSchema,
  autoScheduleSchema,
  kitRefKey,
  kitRefSchema,
} from "./core/types.js";

// ---- Ports ---------------------------------------------------------------
export type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  ConfigProvider,
  ScheduleRunResult,
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

// ---- Sandbox executor (the hands) ---------------------------------------
export {
  makeSandboxExecutor,
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
  loadAutoDynamoTableNames,
  makeAwsAutoDeps,
} from "./adapters/aws/index.js";
export type {
  AutoDynamoTableNames,
  MakeAwsAutoDepsOptions,
} from "./adapters/aws/index.js";

// ---- Self-host adapter ---------------------------------------------------
export {
  makeSelfHostAutoDeps,
  PostgresAutoApprovalRepository,
  PostgresAutoRunRepository,
  PostgresAutoScheduleRepository,
} from "./adapters/selfhost/postgres.js";
export type {
  MakeSelfHostAutoDepsOptions,
  PgPool,
} from "./adapters/selfhost/postgres.js";
