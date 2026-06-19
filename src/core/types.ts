/**
 * Core domain types for AgentKitAuto — hosted autonomous Agent Kit runs.
 *
 * PHASE A scope (this package): on-demand, fire-and-forget, run-to-completion.
 * A run is a single autonomous execution of a kit against a per-run input, under
 * a standing approval, bounded by a REQUIRED per-run credit budget, with a
 * non-interactive policy-gated sandbox executor as the only "hands". No
 * scheduling, no event triggers, no network egress, no delivery (deferred to
 * later phases — see README).
 *
 * BILLING:
 *   - Phase A is MANAGED billing only: the platform provider key is used and the
 *     run is debited against the user's prepaid credit balance through
 *     @agentkitforge/gateway-core's CreditLedgerRepository (two-phase hold per
 *     turn). This package NEVER redefines pricing or billing math — it reuses
 *     gateway-core's computeDebitCents / runManagedTurn.
 *
 * SAFETY MODEL:
 *   - A run is permitted ONLY if a matching, non-revoked AutoApproval exists for
 *     the kit AND the run's budgetCents <= approval.maxBudgetCents.
 *   - The approval's toolAllowlist IS the consent. There is no per-call human
 *     confirm in Auto (the key difference vs the interactive gateway loop).
 *   - The sandbox executor supports ONLY workspace-confined file tools; there is
 *     NO autonomous shell (`run_command`) anywhere in Phase A.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Kit reference
// ---------------------------------------------------------------------------

/**
 * Where a run's kit comes from. Mirrors the provenance fields used elsewhere in
 * the ecosystem (Bridge 5): a hosted-Market kit (source "market") or a local
 * kit id (source "local").
 */
export const kitRefSchema = z
  .object({
    source: z.enum(["market", "local"]),
    /** Market kit id (source === "market"). */
    marketKitId: z.string().min(1).optional(),
    /** Market slug, denormalised for display (source === "market"). */
    slug: z.string().min(1).optional(),
    /** Local kit id (source === "local"). */
    localKitId: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      v.source === "market"
        ? typeof v.marketKitId === "string"
        : typeof v.localKitId === "string",
    { message: "kitRef must carry marketKitId (market) or localKitId (local)" },
  );

export type KitRef = z.infer<typeof kitRefSchema>;

/** Stable equality for matching a run's kitRef against an approval's kitRef. */
export function kitRefKey(ref: KitRef): string {
  return ref.source === "market"
    ? `market:${ref.marketKitId}`
    : `local:${ref.localKitId}`;
}

// ---------------------------------------------------------------------------
// Approvals (standing approval)
// ---------------------------------------------------------------------------

/**
 * Phase A network policy. Only `deny_all` is permitted — egress is deferred to
 * Phase C. The field is included now so the contract is stable across phases.
 */
export const networkPolicySchema = z.literal("deny_all");
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

/** Phase A scope: a per-run ephemeral workspace the run may read + write. */
export const approvalScopeSchema = z.literal("workspace_read_write");
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

/**
 * A standing approval: the user's pre-authorization for autonomous runs of a
 * specific kit. The toolAllowlist is the consent surface — the run may only use
 * tools in this list (further intersected with the kit's declared tools and the
 * Phase A sandbox tool set).
 */
export const autoApprovalSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kitRef: kitRefSchema,
  scope: approvalScopeSchema,
  /** Tool names the user authorizes for autonomous use. */
  toolAllowlist: z.array(z.string().min(1)),
  /** Phase A: always "deny_all". */
  networkPolicy: networkPolicySchema,
  /** Ceiling (US cents) a single run under this approval may set as its budget. */
  maxBudgetCents: z.number().int().positive(),
  createdAt: z.string().min(1),
  /** Set when revoked; a revoked approval never permits a run. */
  revokedAt: z.string().min(1).nullable(),
});

export type AutoApproval = z.infer<typeof autoApprovalSchema>;

export interface CreateApprovalInput {
  userId: string;
  kitRef: KitRef;
  toolAllowlist: string[];
  maxBudgetCents: number;
  scope?: ApprovalScope;
  networkPolicy?: NetworkPolicy;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const autoRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "budget_exceeded",
]);
export type AutoRunStatus = z.infer<typeof autoRunStatusSchema>;

/** A per-run input file the user supplies (seeded into the workspace). */
export const autoRunInputFileSchema = z.object({
  /** Workspace-relative path. */
  path: z.string().min(1),
  /** UTF-8 file contents. */
  content: z.string(),
});
export type AutoRunInputFile = z.infer<typeof autoRunInputFileSchema>;

export const autoRunInputSchema = z.object({
  /** User-provided per-run instruction string (the task). */
  prompt: z.string(),
  /** Optional files seeded into the run workspace before execution. */
  files: z.array(autoRunInputFileSchema).optional(),
});
export type AutoRunInput = z.infer<typeof autoRunInputSchema>;

/** One file produced by the run, surfaced in the result manifest. */
export interface WorkspaceFileEntry {
  /** Workspace-relative path. */
  path: string;
  /** Byte size of the file. */
  sizeBytes: number;
}

/** The terminal result of a successful (or partially-progressed) run. */
export interface AutoRunResult {
  /** Final assistant output text (concatenated text deltas of the last turn). */
  output: string;
  /** Manifest of files present in the workspace at completion. */
  files: WorkspaceFileEntry[];
}

/**
 * How a run's model inference is billed.
 *   - "managed": platform provider key + prepaid credits. Inference is debited
 *     through gateway-core's managed-turn flow at the Auto markup (markupBps).
 *   - "byo": the user's own provider key. Inference is billed by the provider
 *     (e.g. Anthropic) directly; Auto NEVER debits the credit ledger for
 *     inference in this mode.
 */
export type InferenceMode = "managed" | "byo";

/** A single recorded tool call (the audit trail of what the agent did). */
export interface AuditEntry {
  /** The tool invoked. */
  tool: string;
  /** A short, non-sensitive summary of the args (e.g. the path). */
  argsSummary: string;
  /** "ok" | "error" | "rejected". */
  outcome: "ok" | "error" | "rejected";
  /** ISO 8601 timestamp. */
  ts: string;
  /** Optional short detail (error message / rejection reason). */
  detail?: string;
}

/**
 * How a run was triggered.
 *   - "on_demand": the user (or an API caller) created the run directly (Phase A).
 *   - "schedule": the run was created by the cron scheduler (Phase B) on behalf
 *     of a standing AutoSchedule.
 *
 * Defaults to "on_demand" for back-compat with pre-Phase-B run records that
 * carry neither `trigger` nor `scheduleId`.
 */
export type RunTrigger = "on_demand" | "schedule";

/** The persisted record of one autonomous run. */
export interface AutoRun {
  id: string;
  userId: string;
  kitRef: KitRef;
  status: AutoRunStatus;
  input: AutoRunInput;
  /** REQUIRED per-run budget in US cents. No default. */
  budgetCents: number;
  /** Cents debited so far (sum of per-turn settled debits). */
  spentCents: number;
  /**
   * Cents debited for INFERENCE (model turns) only. In managed mode this equals
   * the sum of per-turn settled debits; in BYO mode it is always 0 (the user's
   * own key is billed by the provider, not the ledger). Optional for back-compat
   * with pre-billing-model run records (treated as 0 / === spentCents).
   */
  spentInferenceCents?: number;
  /**
   * Cents debited for the per-minute CLOUD-RUN compute fee. Non-zero ONLY on
   * BYO + cloud runs (we run their job on our compute but collect no inference
   * markup). Zero/absent for managed, local/desktop, and self-host runs.
   */
  spentComputeCents?: number;
  /**
   * How this run's inference is billed. Defaults to "managed" for back-compat
   * with run records created before BYO Auto existed.
   */
  inferenceMode?: InferenceMode;
  /** True when the run executes on OUR hosted compute (Fargate/hosted worker). */
  isCloudRun?: boolean;
  /**
   * Per-minute cloud-run compute fee in US cents. Only meaningful when
   * isCloudRun && inferenceMode === "byo". 0/absent disables the fee.
   */
  cloudRunCentsPerMin?: number;
  /** Canonical model id (e.g. "claude-sonnet-4-6"). */
  model: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Final output + workspace manifest (set on success / partial completion). */
  result?: AutoRunResult;
  /** Failure message (status === "failed"). */
  error?: string;
  /** Append-only audit log of tool calls. */
  auditLog: AuditEntry[];
  /** The ephemeral workspace backing this run (set when execution starts). */
  workspaceId?: string;
  /** True when a kill-switch cancel was requested for this run. */
  cancelRequested?: boolean;
  /**
   * How this run was triggered. Defaults to "on_demand" when absent (Phase A
   * back-compat). "schedule" runs also carry `scheduleId`.
   */
  trigger?: RunTrigger;
  /** The AutoSchedule that produced this run (set iff trigger === "schedule"). */
  scheduleId?: string;
}

export interface CreateRunInput {
  userId: string;
  kitRef: KitRef;
  input: AutoRunInput;
  budgetCents: number;
  model: string;
  createdAt: string;
  /** Billing mode for this run. Defaults to "managed" when omitted. */
  inferenceMode?: InferenceMode;
  /** True when the run will execute on our hosted compute (Fargate/hosted). */
  isCloudRun?: boolean;
  /** Per-minute cloud-run compute fee (cents); only billed on BYO + cloud runs. */
  cloudRunCentsPerMin?: number;
  /** How this run was triggered. Defaults to "on_demand" when omitted. */
  trigger?: RunTrigger;
  /** The AutoSchedule that produced this run (only with trigger "schedule"). */
  scheduleId?: string;
}

// ---------------------------------------------------------------------------
// Schedules (Phase B — scheduled / cron Auto runs)
// ---------------------------------------------------------------------------

/**
 * A standing schedule: fires an autonomous run of a kit on a recurring cron
 * cadence, under an existing standing AutoApproval, bounded by a REQUIRED
 * per-run budget. The scheduler (schedule-runner) creates one AutoRun per fire
 * with `trigger: "schedule"` and `scheduleId` set, reusing the exact Phase A
 * approval gate + run-create + dispatch path (injected, never hard-depended on).
 *
 * SAFETY: a schedule does NOT widen consent. Each fire is still gated by the
 * referenced approval (`approvalId` is advisory/denormalised; the gate matches
 * on (userId, kitRef) like an on-demand run) and `budgetCents <=
 * approval.maxBudgetCents`.
 */
export const autoScheduleSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kitRef: kitRefSchema,
  /** Standard 5-field cron expression (minute hour dom month dow). */
  cron: z.string().min(1),
  /** IANA timezone the cron is evaluated in. Defaults to "UTC". */
  timezone: z.string().min(1),
  /** The per-run task input (same shape Phase A runs use). */
  input: autoRunInputSchema,
  /** REQUIRED per-run budget in US cents. */
  budgetCents: z.number().int().positive(),
  /** Canonical model id for fired runs. */
  model: z.string().min(1),
  /**
   * The standing AutoApproval id this schedule runs under (denormalised for
   * display + a fast existence check). The approval gate still matches on
   * (userId, kitRef) at fire time, so a re-keyed approval continues to work.
   */
  approvalId: z.string().min(1),
  /** Inference billing mode hint for fired runs. Defaults to "managed". */
  inferenceMode: z.enum(["managed", "byo"]).optional(),
  /** Whether the schedule is active. Disabled schedules never fire. */
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** ISO of the last fire (null until first fire). */
  lastRunAt: z.string().min(1).nullable(),
  /** Run id produced by the last fire (null until first successful dispatch). */
  lastRunId: z.string().min(1).nullable(),
  /** Computed ISO of the NEXT scheduled fire (the due-selection key). */
  nextRunAt: z.string().min(1),
  /** Last fire error (skip reason / dispatch failure); null when last fire was clean. */
  lastError: z.string().min(1).nullable(),
});

export type AutoSchedule = z.infer<typeof autoScheduleSchema>;

export interface CreateScheduleInput {
  userId: string;
  kitRef: KitRef;
  cron: string;
  /** IANA timezone. Defaults to "UTC" when omitted. */
  timezone?: string;
  input: AutoRunInput;
  budgetCents: number;
  model: string;
  approvalId: string;
  inferenceMode?: InferenceMode;
  /** Defaults to true (enabled) when omitted. */
  enabled?: boolean;
  createdAt: string;
  /**
   * The first nextRunAt, computed by the caller via nextFireAfter(cron,
   * createdAt, timezone). The adapter persists it verbatim so the scheduler can
   * select due rows without re-parsing cron on write.
   */
  nextRunAt: string;
}

/** Fields an updateSchedule call may change (enable/disable/edit). */
export interface UpdateScheduleInput {
  cron?: string;
  timezone?: string;
  input?: AutoRunInput;
  budgetCents?: number;
  model?: string;
  approvalId?: string;
  inferenceMode?: InferenceMode;
  enabled?: boolean;
  /** Recomputed when cron/timezone/enabled change; caller supplies the new value. */
  nextRunAt?: string;
  /** Always stamped by the caller. */
  updatedAt: string;
}
