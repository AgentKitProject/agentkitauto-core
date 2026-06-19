-- AgentKitAuto Core — self-host Postgres schema (Phase A).
-- Run once at container startup (idempotent: CREATE TABLE IF NOT EXISTS).
-- Design mirrors agentkitgateway-core / agentkitmarket-core schema patterns.
--
-- Phase A: on-demand autonomous runs only. JSONB columns hold the structured
-- sub-objects (kit_ref, input, result, audit_log) so the row shape matches the
-- AutoRun / AutoApproval domain types without a wide column explosion.

-- ---------------------------------------------------------------------------
-- Auto runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_runs (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  status            TEXT        NOT NULL,   -- queued|running|succeeded|failed|canceled|budget_exceeded
  input             JSONB       NOT NULL,   -- { prompt, files? }
  budget_cents      INTEGER     NOT NULL,   -- REQUIRED per-run budget
  spent_cents       INTEGER     NOT NULL DEFAULT 0,
  -- Billing-model split (see @agentkitforge/auto-core run-driver):
  spent_inference_cents   INTEGER NOT NULL DEFAULT 0,  -- model turns (0 in BYO)
  spent_compute_cents     INTEGER NOT NULL DEFAULT 0,  -- per-minute cloud-run fee
  inference_mode          TEXT    NOT NULL DEFAULT 'managed',  -- managed|byo
  is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE,
  cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0,
  model             TEXT        NOT NULL,
  created_at        TEXT        NOT NULL,   -- ISO 8601
  started_at        TEXT,
  finished_at       TEXT,
  result            JSONB,                  -- { output, files[] }
  error             TEXT,
  audit_log         JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- append-only
  workspace_id      TEXT,
  cancel_requested  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Phase B (scheduled runs): how this run was triggered + the firing schedule.
  trigger           TEXT        NOT NULL DEFAULT 'on_demand',  -- on_demand|schedule
  schedule_id       TEXT
);

CREATE INDEX IF NOT EXISTS auto_runs_user_idx ON auto_runs (user_id, created_at DESC);

-- Idempotent migration for existing deployments (columns added 2026-06 for the
-- AgentKitAuto billing model). ADD COLUMN IF NOT EXISTS is a no-op when present.
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_inference_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_compute_cents     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS inference_mode          TEXT    NOT NULL DEFAULT 'managed';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Auto approvals (standing approvals)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_approvals (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  -- Denormalised matching key (user_id # kitRefKey) for getApprovalForKit.
  user_kit_key      TEXT        NOT NULL,
  scope             TEXT        NOT NULL,   -- workspace_read_write
  tool_allowlist    JSONB       NOT NULL,   -- string[]
  network_policy    TEXT        NOT NULL,   -- deny_all (Phase A)
  max_budget_cents  INTEGER     NOT NULL,
  created_at        TEXT        NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS auto_approvals_user_idx ON auto_approvals (user_id);
CREATE INDEX IF NOT EXISTS auto_approvals_user_kit_idx ON auto_approvals (user_kit_key);

-- Idempotent migration for existing deployments (Phase B columns).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS trigger     TEXT NOT NULL DEFAULT 'on_demand';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS schedule_id TEXT;

-- ---------------------------------------------------------------------------
-- Auto schedules (Phase B — scheduled / cron runs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_schedules (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  cron              TEXT        NOT NULL,   -- standard 5-field cron
  timezone          TEXT        NOT NULL DEFAULT 'UTC',  -- IANA tz
  input             JSONB       NOT NULL,   -- per-run { prompt, files? }
  budget_cents      INTEGER     NOT NULL,   -- REQUIRED per-run budget
  model             TEXT        NOT NULL,
  approval_id       TEXT        NOT NULL,   -- standing approval this runs under
  inference_mode    TEXT,                   -- managed|byo (NULL = run default)
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TEXT        NOT NULL,   -- ISO 8601
  updated_at        TEXT        NOT NULL,
  last_run_at       TEXT,                   -- ISO of last fire (NULL until first)
  last_run_id       TEXT,                   -- run id of last fire
  next_run_at       TEXT        NOT NULL,   -- ISO of next scheduled fire (due key)
  last_error        TEXT                    -- last skip/dispatch error
);

CREATE INDEX IF NOT EXISTS auto_schedules_user_idx ON auto_schedules (user_id);
-- Due-selection: enabled schedules ordered by next_run_at.
CREATE INDEX IF NOT EXISTS auto_schedules_due_idx ON auto_schedules (enabled, next_run_at);
