/**
 * Ports: the runtime- and cloud-agnostic interfaces the Auto core depends on.
 *
 * Each storage port has two adapters (see ../adapters):
 *   - aws/      → DynamoDB (+ S3 / tmp dir for workspaces)
 *   - selfhost/ → Postgres (+ local disk for workspaces)
 *
 * The core (sandbox-executor, run-driver, worker) MUST depend ONLY on these
 * ports — never on a concrete adapter or cloud SDK — so the domain logic is
 * identical across hosted and self-hosted runtimes (mirrors gateway-core /
 * market-core).
 *
 * Billing + the chat/tool engine are NOT re-declared here: Auto reuses
 * @agentkitforge/gateway-core's ChatProvider + CreditLedgerRepository +
 * runManagedTurn directly. The run-driver takes those as injected deps.
 */

import type {
  AuditEntry,
  AutoApproval,
  AutoRun,
  AutoRunInputFileRef,
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  AutoWebhook,
  CreateApprovalInput,
  CreateRunInput,
  CreateScheduleInput,
  CreateWebhookInput,
  KitRef,
  UpdateScheduleInput,
  WebhookFireResult,
  WorkspaceFileEntry,
} from "./types.js";

/** Application configuration + secrets, sourced per runtime. */
export interface ConfigProvider {
  /** Returns a config value; throws if `required` and missing. */
  get(key: string, required?: boolean): string | undefined;
}

// ---------------------------------------------------------------------------
// AutoRunRepository
// ---------------------------------------------------------------------------

/**
 * Persists run lifecycle, audit, spend, result, and the kill-switch flag.
 *
 * INVARIANTS:
 *   - auditLog is append-only (appendAudit never rewrites prior entries).
 *   - spentCents only increases (recordSpend adds).
 *   - requestCancel is idempotent; isCancelRequested reflects the latest flag.
 */
export interface AutoRunRepository {
  createRun(input: CreateRunInput): Promise<AutoRun>;
  getRun(runId: string): Promise<AutoRun | undefined>;
  listRunsByUser(userId: string, limit?: number): Promise<AutoRun[]>;
  /** Updates status and optionally stamps startedAt/finishedAt/error plus the
   *  billing-split totals (spentInferenceCents/spentComputeCents). */
  updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields?: {
      startedAt?: string;
      finishedAt?: string;
      error?: string;
      workspaceId?: string;
      spentInferenceCents?: number;
      spentComputeCents?: number;
    },
  ): Promise<AutoRun | undefined>;
  /** Appends one audit entry (never replaces existing entries). */
  appendAudit(runId: string, entry: AuditEntry): Promise<void>;
  /** Sets the terminal result (final output + workspace manifest). */
  setResult(runId: string, result: AutoRunResult): Promise<void>;
  /** Adds to spentCents and returns the new total. */
  recordSpend(runId: string, deltaCents: number): Promise<number>;
  /** Kill-switch: mark the run for cancellation (idempotent). */
  requestCancel(runId: string): Promise<void>;
  /** Kill-switch read: true if a cancel was requested. */
  isCancelRequested(runId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// AutoApprovalRepository
// ---------------------------------------------------------------------------

/** Persists standing approvals. */
export interface AutoApprovalRepository {
  createApproval(input: CreateApprovalInput): Promise<AutoApproval>;
  /** Returns the non-revoked approval matching (userId, kitRef), if any. */
  getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined>;
  listApprovalsByUser(userId: string): Promise<AutoApproval[]>;
  /** Flips an approval to revoked; returns the updated row or undefined. */
  revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined>;
}

// ---------------------------------------------------------------------------
// AutoScheduleRepository (Phase B)
// ---------------------------------------------------------------------------

/** The result fields the scheduler stamps after firing (or skipping) a schedule. */
export interface ScheduleRunResult {
  /** When the schedule was processed this sweep (ISO). */
  lastRunAt: string;
  /** Run id produced by the fire, or null when the fire was skipped. */
  lastRunId: string | null;
  /** The recomputed next fire time (ISO) — always advanced to avoid hot-loops. */
  nextRunAt: string;
  /** Skip reason / dispatch error, or null when the fire was clean. */
  lastError: string | null;
}

/**
 * Persists standing schedules (Phase B).
 *
 * INVARIANTS:
 *   - listDueSchedules returns ENABLED schedules whose nextRunAt <= now.
 *   - setScheduleRunResult always advances nextRunAt (the scheduler computes the
 *     next fire BEFORE dispatch and persists it) so a re-entrant sweep within
 *     the same minute cannot double-fire.
 */
export interface AutoScheduleRepository {
  createSchedule(input: CreateScheduleInput): Promise<AutoSchedule>;
  getSchedule(scheduleId: string): Promise<AutoSchedule | undefined>;
  listSchedulesByUser(userId: string): Promise<AutoSchedule[]>;
  /** Enabled schedules due to fire (nextRunAt <= nowISO). */
  listDueSchedules(nowISO: string): Promise<AutoSchedule[]>;
  /** Edits a schedule (enable/disable/edit); returns the updated row or undefined. */
  updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined>;
  /** Records the outcome of a fire/skip (lastRunAt/lastRunId/nextRunAt/lastError). */
  setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void>;
  deleteSchedule(scheduleId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// AutoWebhookRepository (Phase C)
// ---------------------------------------------------------------------------

/**
 * Persists standing webhook triggers (Phase C).
 *
 * INVARIANTS:
 *   - `secretHash` is stored verbatim; the plaintext secret is NEVER persisted.
 *   - recordFire is additive on fireCount and stamps lastFiredAt/lastRunId.
 *   - getWebhook returns the webhook regardless of enabled state (consumeWebhook
 *     enforces the enabled check so it can return a typed disabled error).
 */
export interface AutoWebhookRepository {
  createWebhook(input: CreateWebhookInput): Promise<AutoWebhook>;
  getWebhook(webhookId: string): Promise<AutoWebhook | undefined>;
  listWebhooksByUser(userId: string): Promise<AutoWebhook[]>;
  /** Stamps the outcome of a successful fire (lastFiredAt/lastRunId, ++fireCount). */
  recordFire(webhookId: string, result: WebhookFireResult): Promise<void>;
  /** Enables/disables a webhook; returns the updated row or undefined. */
  setEnabled(webhookId: string, enabled: boolean): Promise<AutoWebhook | undefined>;
  deleteWebhook(webhookId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InputStore (Phase C — out-of-band per-run input files)
// ---------------------------------------------------------------------------

/**
 * Stages + hydrates per-run input files supplied OUT-OF-BAND (the web layer
 * uploads them — e.g. via presigned S3 PUT — then records the manifest on the
 * run). The worker hydrates them into the run workspace's `inputs/` subdir
 * BEFORE execution. All filenames are path-confined (no traversal/symlink
 * escape) exactly like every other workspace op.
 *
 *   - aws/      → S3 under a per-run prefix `auto-inputs/{runId}/...`.
 *   - selfhost/ → local disk / MinIO under a per-run dir.
 */
export interface InputStore {
  /**
   * Records/uploads staged input files for a run and returns the manifest to
   * persist on the run. (The web layer typically uploads bytes via presigned
   * URLs; this method may be a no-op manifest builder in that flow, or it may
   * accept inline content for the self-host/local path.)
   */
  stageInputs(runId: string, files: StagedInputFile[]): Promise<AutoRunInputFileRef[]>;
  /**
   * Copies every staged input file for a run into the workspace under `inputs/`,
   * path-confined. Returns the workspace-relative paths written.
   */
  hydrateInputsIntoWorkspace(
    runId: string,
    workspace: WorkspaceStore,
    workspaceId: string,
    manifest: AutoRunInputFileRef[],
  ): Promise<string[]>;
}

/** An input file presented for staging (inline content or a backing key). */
export interface StagedInputFile {
  /** Workspace-relative path (placed under `inputs/`); path-confined. */
  path: string;
  /** Inline UTF-8 content (self-host/local) — mutually exclusive with s3Key. */
  content?: string;
  /** Pre-uploaded backing object key (aws presigned flow). */
  s3Key?: string;
}

// ---------------------------------------------------------------------------
// EmailSender (Phase D — opt-in result delivery)
// ---------------------------------------------------------------------------

/** One email to deliver (the DeliveryService builds the subject + body). */
export interface OutboundEmail {
  /** Recipient addresses (basic-format validated upstream). */
  to: string[];
  subject: string;
  /** Plain-text body (always present). */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

/**
 * Sends a notification email (Phase D result delivery). Provider-specific:
 *   - aws/      → SES v2 (`SendEmailCommand`), sender from env `SES_SENDER`. When
 *                 `SES_SENDER` is unset the implementation is an INERT no-op
 *                 (returns `{ status: "skipped" }`) so missing config can never
 *                 break a run.
 *   - selfhost/ → nodemailer SMTP, configured via `SMTP_HOST`/`SMTP_FROM` (+ optional
 *                 `SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`). INERT (skipped)
 *                 when `SMTP_HOST` or `SMTP_FROM` is unset so unconfigured deployments
 *                 never break (webhook delivery still works).
 *
 * The implementation MUST NOT throw on a delivery failure — it returns a
 * `{ status: "failed", error }` outcome so the run is never affected.
 */
export interface EmailSender {
  sendEmail(email: OutboundEmail): Promise<EmailSendResult>;
}

/** The result of one `EmailSender.sendEmail` call. */
export interface EmailSendResult {
  status: "delivered" | "failed" | "skipped";
  /** Failure / skip detail (absent on a clean delivery). */
  error?: string;
}

// ---------------------------------------------------------------------------
// WorkspaceStore (the "hands" substrate)
// ---------------------------------------------------------------------------

/**
 * Per-run ephemeral workspace. The sandbox executor is the ONLY thing that
 * touches it, and every path it passes is canonicalized + confined to the
 * workspace root by the implementation (starts-with check + traversal/symlink
 * rejection). There is NO run_command — the workspace exposes file ops only.
 */
export interface WorkspaceStore {
  /** Creates a fresh workspace for a run; returns an opaque workspaceId. */
  createWorkspace(runId: string): Promise<string>;
  /** Reads a UTF-8 file scoped to the workspace. Throws on escape / missing. */
  readFile(workspaceId: string, path: string): Promise<string>;
  /** Lists directory entries (relative paths) scoped to the workspace. */
  listDir(workspaceId: string, path: string): Promise<string[]>;
  /** Writes a UTF-8 file scoped to the workspace (creating parent dirs). */
  writeFile(workspaceId: string, path: string, content: string): Promise<void>;
  /** Returns the manifest of all files in the workspace (for the run result). */
  bundleResult(workspaceId: string): Promise<WorkspaceFileEntry[]>;
  /** Tears down the workspace and frees its storage. */
  cleanup(workspaceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Composed dependency bundle
// ---------------------------------------------------------------------------

/** The storage-layer dependencies, produced by makeAutoDeps({ backend }). */
export interface AutoStorageDeps {
  runs: AutoRunRepository;
  approvals: AutoApprovalRepository;
  workspaces: WorkspaceStore;
  /** Phase B: standing schedules. */
  schedules: AutoScheduleRepository;
  /** Phase C: standing webhooks (inbound event triggers). */
  webhooks: AutoWebhookRepository;
  /** Phase C: staged per-run input files. */
  inputs: InputStore;
}
