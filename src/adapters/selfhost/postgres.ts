/**
 * Postgres self-host adapter for the Auto core.
 *
 * Implements:
 *   - AutoRunRepository       over Postgres (atomic UPDATE for spend, JSONB
 *                             append for audit via jsonb concatenation).
 *   - AutoApprovalRepository  over Postgres.
 *   - WorkspaceStore          via FsWorkspaceStore on a local disk path (k8s PV).
 *
 * Uses the standard `pg` Pool interface — no ORM, raw SQL. Schema in schema.sql.
 * Mirrors agentkitgateway-core / agentkitmarket-core selfhost adapters.
 */

import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";
import * as os from "node:os";
import type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  AutoWebhookRepository,
  InputStore,
  ScheduleRunResult,
} from "../../core/ports.js";
import type {
  AuditEntry,
  AutoApproval,
  AutoRun,
  AutoRunInput,
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
} from "../../core/types.js";
import { kitRefKey, normalizeNetworkPolicy } from "../../core/types.js";
import { FsWorkspaceStore } from "../../core/fs-workspace.js";
import { LocalInputStore } from "../../core/input-store.js";

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

/** pg returns JSONB as parsed objects; pg-mem may return strings. Normalize. */
function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function rowToRun(row: Record<string, unknown>): AutoRun {
  const run: AutoRun = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    status: row["status"] as AutoRunStatus,
    input: asJson<AutoRun["input"]>(row["input"]),
    budgetCents: Number(row["budget_cents"]),
    spentCents: Number(row["spent_cents"]),
    spentInferenceCents: Number(row["spent_inference_cents"] ?? 0),
    spentComputeCents: Number(row["spent_compute_cents"] ?? 0),
    inferenceMode: (row["inference_mode"] as AutoRun["inferenceMode"]) ?? "managed",
    isCloudRun: row["is_cloud_run"] === true || row["is_cloud_run"] === "true",
    cloudRunCentsPerMin: Number(row["cloud_run_cents_per_min"] ?? 0),
    model: row["model"] as string,
    createdAt: row["created_at"] as string,
    auditLog: asJson<AuditEntry[]>(row["audit_log"] ?? "[]"),
    cancelRequested: row["cancel_requested"] === true || row["cancel_requested"] === "true",
    trigger: (row["trigger"] as AutoRun["trigger"]) ?? "on_demand",
  };
  if (row["schedule_id"]) run.scheduleId = row["schedule_id"] as string;
  if (row["webhook_id"]) run.webhookId = row["webhook_id"] as string;
  if (row["input_files"]) run.inputFiles = asJson<AutoRunInputFileRef[]>(row["input_files"]);
  if (row["started_at"]) run.startedAt = row["started_at"] as string;
  if (row["finished_at"]) run.finishedAt = row["finished_at"] as string;
  if (row["error"]) run.error = row["error"] as string;
  if (row["workspace_id"]) run.workspaceId = row["workspace_id"] as string;
  if (row["result"]) run.result = asJson<AutoRunResult>(row["result"]);
  return run;
}

function rowToApproval(row: Record<string, unknown>): AutoApproval {
  return {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    scope: row["scope"] as AutoApproval["scope"],
    toolAllowlist: asJson<string[]>(row["tool_allowlist"]),
    // network_policy is stored as JSONB (Phase C); legacy rows may hold the bare
    // string "deny_all". normalizeNetworkPolicy handles both → object shape.
    networkPolicy: normalizeNetworkPolicy(asJson<unknown>(row["network_policy"])),
    maxBudgetCents: Number(row["max_budget_cents"]),
    createdAt: row["created_at"] as string,
    revokedAt: (row["revoked_at"] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Postgres AutoRunRepository
// ---------------------------------------------------------------------------

export class PostgresAutoRunRepository implements AutoRunRepository {
  constructor(private readonly pool: PgPool) {}

  async createRun(input: CreateRunInput): Promise<AutoRun> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_runs
         (id, user_id, kit_ref, status, input, budget_cents, spent_cents,
          spent_inference_cents, spent_compute_cents, inference_mode,
          is_cloud_run, cloud_run_cents_per_min, model, created_at, audit_log, cancel_requested,
          trigger, schedule_id, webhook_id, input_files)
       VALUES ($1,$2,$3,'queued',$4,$5,0,0,0,$6,$7,$8,$9,$10,$11,FALSE,$12,$13,$14,$15)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        JSON.stringify(input.input),
        input.budgetCents,
        input.inferenceMode ?? "managed",
        input.isCloudRun ?? false,
        input.cloudRunCentsPerMin ?? 0,
        input.model,
        input.createdAt,
        "[]",
        input.trigger ?? "on_demand",
        input.scheduleId ?? null,
        input.webhookId ?? null,
        input.inputFiles ? JSON.stringify(input.inputFiles) : null,
      ],
    );
    return rowToRun(rows[0]!);
  }

  async getRun(runId: string): Promise<AutoRun | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_runs WHERE id = $1", [runId]);
    return rows[0] ? rowToRun(rows[0]) : undefined;
  }

  async listRunsByUser(userId: string, limit = 50): Promise<AutoRun[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    return rows.map(rowToRun);
  }

  async updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields: {
      startedAt?: string;
      finishedAt?: string;
      error?: string;
      workspaceId?: string;
      spentInferenceCents?: number;
      spentComputeCents?: number;
    } = {},
  ): Promise<AutoRun | undefined> {
    const sets = ["status = $2"];
    const params: unknown[] = [runId, status];
    const colMap: Record<string, string> = {
      startedAt: "started_at",
      finishedAt: "finished_at",
      error: "error",
      workspaceId: "workspace_id",
      spentInferenceCents: "spent_inference_cents",
      spentComputeCents: "spent_compute_cents",
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${colMap[k]} = $${params.length}`);
    }
    const { rows } = await this.pool.query(
      `UPDATE auto_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRun(rows[0]) : undefined;
  }

  async appendAudit(runId: string, entry: AuditEntry): Promise<void> {
    // Read-modify-write the JSONB array. Portable across real Postgres and
    // pg-mem (whose `||`/`jsonb_insert` jsonb operators are limited). Audit
    // appends are low-frequency, so a round-trip per entry is acceptable.
    const { rows } = await this.pool.query("SELECT audit_log FROM auto_runs WHERE id = $1", [runId]);
    if (!rows[0]) return;
    const current = asJson<AuditEntry[]>(rows[0]["audit_log"] ?? "[]");
    current.push(entry);
    await this.pool.query("UPDATE auto_runs SET audit_log = $2 WHERE id = $1", [
      runId,
      JSON.stringify(current),
    ]);
  }

  async setResult(runId: string, result: AutoRunResult): Promise<void> {
    await this.pool.query("UPDATE auto_runs SET result = $2 WHERE id = $1", [
      runId,
      JSON.stringify(result),
    ]);
  }

  async recordSpend(runId: string, deltaCents: number): Promise<number> {
    const { rows } = await this.pool.query(
      "UPDATE auto_runs SET spent_cents = spent_cents + $2 WHERE id = $1 RETURNING spent_cents",
      [runId, deltaCents],
    );
    return Number(rows[0]?.["spent_cents"] ?? deltaCents);
  }

  async requestCancel(runId: string): Promise<void> {
    await this.pool.query("UPDATE auto_runs SET cancel_requested = TRUE WHERE id = $1", [runId]);
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT cancel_requested FROM auto_runs WHERE id = $1",
      [runId],
    );
    const v = rows[0]?.["cancel_requested"];
    return v === true || v === "true";
  }
}

// ---------------------------------------------------------------------------
// Postgres AutoApprovalRepository
// ---------------------------------------------------------------------------

export class PostgresAutoApprovalRepository implements AutoApprovalRepository {
  constructor(private readonly pool: PgPool) {}

  async createApproval(input: CreateApprovalInput): Promise<AutoApproval> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_approvals
         (id, user_id, kit_ref, user_kit_key, scope, tool_allowlist, network_policy, max_budget_cents, created_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        `${input.userId}#${kitRefKey(input.kitRef)}`,
        input.scope ?? "workspace_read_write",
        JSON.stringify(input.toolAllowlist),
        JSON.stringify(normalizeNetworkPolicy(input.networkPolicy)),
        input.maxBudgetCents,
        input.createdAt,
      ],
    );
    return rowToApproval(rows[0]!);
  }

  async getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_approvals WHERE user_kit_key = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [`${userId}#${kitRefKey(kitRef)}`],
    );
    return rows[0] ? rowToApproval(rows[0]) : undefined;
  }

  async listApprovalsByUser(userId: string): Promise<AutoApproval[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_approvals WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToApproval);
  }

  async revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined> {
    const { rows } = await this.pool.query(
      "UPDATE auto_approvals SET revoked_at = $2 WHERE id = $1 RETURNING *",
      [approvalId, revokedAt],
    );
    return rows[0] ? rowToApproval(rows[0]) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Postgres AutoScheduleRepository (Phase B)
// ---------------------------------------------------------------------------

function rowToSchedule(row: Record<string, unknown>): AutoSchedule {
  const schedule: AutoSchedule = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    cron: row["cron"] as string,
    timezone: row["timezone"] as string,
    input: asJson<AutoRunInput>(row["input"]),
    budgetCents: Number(row["budget_cents"]),
    model: row["model"] as string,
    approvalId: row["approval_id"] as string,
    enabled: row["enabled"] === true || row["enabled"] === "true",
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    lastRunAt: (row["last_run_at"] as string | null) ?? null,
    lastRunId: (row["last_run_id"] as string | null) ?? null,
    nextRunAt: row["next_run_at"] as string,
    lastError: (row["last_error"] as string | null) ?? null,
  };
  if (row["inference_mode"]) {
    schedule.inferenceMode = row["inference_mode"] as AutoSchedule["inferenceMode"];
  }
  return schedule;
}

export class PostgresAutoScheduleRepository implements AutoScheduleRepository {
  constructor(private readonly pool: PgPool) {}

  async createSchedule(input: CreateScheduleInput): Promise<AutoSchedule> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_schedules
         (id, user_id, kit_ref, cron, timezone, input, budget_cents, model,
          approval_id, inference_mode, enabled, created_at, updated_at,
          last_run_at, last_run_id, next_run_at, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,NULL,NULL,$13,NULL)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        input.cron,
        input.timezone ?? "UTC",
        JSON.stringify(input.input),
        input.budgetCents,
        input.model,
        input.approvalId,
        input.inferenceMode ?? null,
        input.enabled ?? true,
        input.createdAt,
        input.nextRunAt,
      ],
    );
    return rowToSchedule(rows[0]!);
  }

  async getSchedule(scheduleId: string): Promise<AutoSchedule | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_schedules WHERE id = $1", [
      scheduleId,
    ]);
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  async listSchedulesByUser(userId: string): Promise<AutoSchedule[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_schedules WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToSchedule);
  }

  async listDueSchedules(nowISO: string): Promise<AutoSchedule[]> {
    // enabled && next_run_at <= now. Indexed on (enabled, next_run_at).
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_schedules WHERE enabled = TRUE AND next_run_at <= $1 ORDER BY next_run_at ASC",
      [nowISO],
    );
    return rows.map(rowToSchedule);
  }

  async updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined> {
    const sets = ["updated_at = $2"];
    const params: unknown[] = [scheduleId, patch.updatedAt];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.cron !== undefined) push("cron", patch.cron);
    if (patch.timezone !== undefined) push("timezone", patch.timezone);
    if (patch.input !== undefined) push("input", JSON.stringify(patch.input));
    if (patch.budgetCents !== undefined) push("budget_cents", patch.budgetCents);
    if (patch.model !== undefined) push("model", patch.model);
    if (patch.approvalId !== undefined) push("approval_id", patch.approvalId);
    if (patch.inferenceMode !== undefined) push("inference_mode", patch.inferenceMode);
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    if (patch.nextRunAt !== undefined) push("next_run_at", patch.nextRunAt);
    const { rows } = await this.pool.query(
      `UPDATE auto_schedules SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  async setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void> {
    await this.pool.query(
      `UPDATE auto_schedules
         SET last_run_at = $2, last_run_id = $3, next_run_at = $4, last_error = $5
       WHERE id = $1`,
      [scheduleId, result.lastRunAt, result.lastRunId, result.nextRunAt, result.lastError],
    );
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_schedules WHERE id = $1", [scheduleId]);
  }
}

// ---------------------------------------------------------------------------
// Postgres AutoWebhookRepository (Phase C)
// ---------------------------------------------------------------------------

function rowToWebhook(row: Record<string, unknown>): AutoWebhook {
  const webhook: AutoWebhook = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    approvalId: row["approval_id"] as string,
    budgetCents: Number(row["budget_cents"]),
    model: row["model"] as string,
    enabled: row["enabled"] === true || row["enabled"] === "true",
    secretHash: row["secret_hash"] as string,
    createdAt: row["created_at"] as string,
    lastFiredAt: (row["last_fired_at"] as string | null) ?? null,
    lastRunId: (row["last_run_id"] as string | null) ?? null,
    lastError: (row["last_error"] as string | null) ?? null,
    fireCount: Number(row["fire_count"] ?? 0),
  };
  if (row["inference_mode"]) {
    webhook.inferenceMode = row["inference_mode"] as AutoWebhook["inferenceMode"];
  }
  return webhook;
}

export class PostgresAutoWebhookRepository implements AutoWebhookRepository {
  constructor(private readonly pool: PgPool) {}

  async createWebhook(input: CreateWebhookInput): Promise<AutoWebhook> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_webhooks
         (id, user_id, kit_ref, approval_id, budget_cents, model, inference_mode,
          enabled, secret_hash, created_at, last_fired_at, last_run_id, last_error, fire_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,NULL,0)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        input.approvalId,
        input.budgetCents,
        input.model,
        input.inferenceMode ?? null,
        input.enabled ?? true,
        input.secretHash,
        input.createdAt,
      ],
    );
    return rowToWebhook(rows[0]!);
  }

  async getWebhook(webhookId: string): Promise<AutoWebhook | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_webhooks WHERE id = $1", [
      webhookId,
    ]);
    return rows[0] ? rowToWebhook(rows[0]) : undefined;
  }

  async listWebhooksByUser(userId: string): Promise<AutoWebhook[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_webhooks WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToWebhook);
  }

  async recordFire(webhookId: string, result: WebhookFireResult): Promise<void> {
    await this.pool.query(
      `UPDATE auto_webhooks
         SET last_fired_at = $2, last_run_id = $3, last_error = $4, fire_count = fire_count + 1
       WHERE id = $1`,
      [webhookId, result.lastFiredAt, result.lastRunId, result.lastError],
    );
  }

  async setEnabled(webhookId: string, enabled: boolean): Promise<AutoWebhook | undefined> {
    const { rows } = await this.pool.query(
      "UPDATE auto_webhooks SET enabled = $2 WHERE id = $1 RETURNING *",
      [webhookId, enabled],
    );
    return rows[0] ? rowToWebhook(rows[0]) : undefined;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_webhooks WHERE id = $1", [webhookId]);
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface MakeSelfHostAutoDepsOptions {
  pool: PgPool;
  /** Workspace root on a local disk / PV. Defaults to an OS tmp dir. */
  workspaceRootDir?: string;
  /**
   * Phase C input store. Defaults to an in-process LocalInputStore (suitable for
   * single-node self-host where the web layer + worker share a process/disk). A
   * MinIO/S3-backed store can be injected here for multi-node deployments.
   */
  inputs?: InputStore;
}

export function makeSelfHostAutoDeps(options: MakeSelfHostAutoDepsOptions): AutoStorageDeps {
  const rootDir =
    options.workspaceRootDir ?? nodePath.join(os.tmpdir(), "agentkitauto-workspaces");
  return {
    runs: new PostgresAutoRunRepository(options.pool),
    approvals: new PostgresAutoApprovalRepository(options.pool),
    schedules: new PostgresAutoScheduleRepository(options.pool),
    webhooks: new PostgresAutoWebhookRepository(options.pool),
    workspaces: new FsWorkspaceStore({ rootDir }),
    inputs: options.inputs ?? new LocalInputStore(),
  };
}

// ---------------------------------------------------------------------------
// Schema (self-host)
// ---------------------------------------------------------------------------

/**
 * The idempotent CREATE TABLE IF NOT EXISTS schema for the Auto self-host
 * Postgres tables (auto_runs, auto_approvals, auto_schedules, auto_webhooks).
 *
 * This is the EXACT content of `schema.sql` embedded as a string so it ships in
 * the compiled `dist/` without needing the .sql file at runtime (the worker +
 * web-forge selfhost backend run it on startup via `ensureAutoSchema`). When you
 * edit schema.sql, keep this string in sync (a test asserts they match).
 */
export const AUTO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auto_runs (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  status            TEXT        NOT NULL,
  input             JSONB       NOT NULL,
  budget_cents      INTEGER     NOT NULL,
  spent_cents       INTEGER     NOT NULL DEFAULT 0,
  spent_inference_cents   INTEGER NOT NULL DEFAULT 0,
  spent_compute_cents     INTEGER NOT NULL DEFAULT 0,
  inference_mode          TEXT    NOT NULL DEFAULT 'managed',
  is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE,
  cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0,
  model             TEXT        NOT NULL,
  created_at        TEXT        NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  result            JSONB,
  error             TEXT,
  audit_log         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  workspace_id      TEXT,
  cancel_requested  BOOLEAN     NOT NULL DEFAULT FALSE,
  trigger           TEXT        NOT NULL DEFAULT 'on_demand',
  schedule_id       TEXT,
  webhook_id        TEXT,
  input_files       JSONB
);

CREATE INDEX IF NOT EXISTS auto_runs_user_idx ON auto_runs (user_id, created_at DESC);

ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_inference_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_compute_cents     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS inference_mode          TEXT    NOT NULL DEFAULT 'managed';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auto_approvals (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  user_kit_key      TEXT        NOT NULL,
  scope             TEXT        NOT NULL,
  tool_allowlist    JSONB       NOT NULL,
  network_policy    JSONB       NOT NULL,
  max_budget_cents  INTEGER     NOT NULL,
  created_at        TEXT        NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS auto_approvals_user_idx ON auto_approvals (user_id);
CREATE INDEX IF NOT EXISTS auto_approvals_user_kit_idx ON auto_approvals (user_kit_key);

ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS trigger     TEXT NOT NULL DEFAULT 'on_demand';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS schedule_id TEXT;

CREATE TABLE IF NOT EXISTS auto_schedules (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  cron              TEXT        NOT NULL,
  timezone          TEXT        NOT NULL DEFAULT 'UTC',
  input             JSONB       NOT NULL,
  budget_cents      INTEGER     NOT NULL,
  model             TEXT        NOT NULL,
  approval_id       TEXT        NOT NULL,
  inference_mode    TEXT,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TEXT        NOT NULL,
  updated_at        TEXT        NOT NULL,
  last_run_at       TEXT,
  last_run_id       TEXT,
  next_run_at       TEXT        NOT NULL,
  last_error        TEXT
);

CREATE INDEX IF NOT EXISTS auto_schedules_user_idx ON auto_schedules (user_id);
CREATE INDEX IF NOT EXISTS auto_schedules_due_idx ON auto_schedules (enabled, next_run_at);

ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS webhook_id  TEXT;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS input_files JSONB;

CREATE TABLE IF NOT EXISTS auto_webhooks (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  approval_id       TEXT        NOT NULL,
  budget_cents      INTEGER     NOT NULL,
  model             TEXT        NOT NULL,
  inference_mode    TEXT,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  secret_hash       TEXT        NOT NULL,
  created_at        TEXT        NOT NULL,
  last_fired_at     TEXT,
  last_run_id       TEXT,
  last_error        TEXT,
  fire_count        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_webhooks_user_idx ON auto_webhooks (user_id);
`;

const ensuredAutoSchema = new WeakSet<object>();

/**
 * Idempotently create the Auto self-host schema. Safe to call on every startup /
 * adapter construction (CREATE TABLE / ADD COLUMN IF NOT EXISTS). Memoised per
 * pool so repeated calls are cheap. The web-forge selfhost backend calls this
 * before first use, and the self-host worker entrypoint calls it on boot.
 */
export async function ensureAutoSchema(pool: PgPool): Promise<void> {
  if (ensuredAutoSchema.has(pool)) return;
  await pool.query(AUTO_SCHEMA_SQL);
  ensuredAutoSchema.add(pool);
}
