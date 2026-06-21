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
import type {
  InferenceMode as ContractsInferenceMode,
  RunTrigger as ContractsRunTrigger,
} from "@agentkitforge/contracts";
import {
  approvalScopeSchema as contractsApprovalScopeSchema,
  autoApprovalSchema as contractsAutoApprovalSchema,
  autoRunInputFileRefSchema as contractsAutoRunInputFileRefSchema,
  autoRunInputFileSchema as contractsAutoRunInputFileSchema,
  autoRunInputSchema as contractsAutoRunInputSchema,
  autoRunStatusSchema as contractsAutoRunStatusSchema,
  autoScheduleSchema as contractsAutoScheduleSchema,
  autoWebhookSchema as contractsAutoWebhookSchema,
  DENY_ALL_NETWORK_POLICY as contractsDenyAllNetworkPolicy,
  kitRefSchema as contractsKitRefSchema,
  networkPolicySchema as contractsNetworkPolicySchema,
} from "@agentkitforge/contracts";

// ---------------------------------------------------------------------------
// Kit reference
// ---------------------------------------------------------------------------

/**
 * Where a run's kit comes from. Mirrors the provenance fields used elsewhere in
 * the ecosystem (Bridge 5): a hosted-Market kit (source "market") or a local
 * kit id (source "local").
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical).
 */
export const kitRefSchema = contractsKitRefSchema;

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
 * Network egress policy for autonomous runs (Phase C).
 *
 *   - `deny_all` (DEFAULT): no network egress whatsoever. The `http_fetch`
 *     sandbox tool is UNAVAILABLE. This is the Phase A/B behavior and remains the
 *     default for every approval that does not explicitly opt in.
 *   - `allowlist`: egress is permitted ONLY to the listed hosts. Each host is an
 *     exact hostname (`api.example.com`) or a wildcard SUFFIX (`*.example.com`,
 *     which matches any subdomain but NOT the apex). `http_fetch` becomes
 *     available only when this mode is set AND `http_fetch` is in the approval's
 *     toolAllowlist. Even then every request is https-only and SSRF-guarded
 *     (private / loopback / link-local / metadata IPs are rejected).
 *
 * Stored on the AutoApproval, so consent for egress is part of the standing
 * approval just like the toolAllowlist. Pre-Phase-C approvals (a bare
 * `"deny_all"` string, or absent) normalize to `{ mode: "deny_all" }`.
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical).
 */
export const networkPolicySchema = contractsNetworkPolicySchema;
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

/** The canonical deny-all policy (the default for every approval). */
export const DENY_ALL_NETWORK_POLICY: NetworkPolicy = contractsDenyAllNetworkPolicy;

/**
 * Normalizes a persisted/legacy network policy into the Phase C shape. Accepts:
 *   - the new object shape (returned as-is after a parse),
 *   - the Phase A/B literal string `"deny_all"`,
 *   - `undefined`/`null` (pre-Phase-C records),
 * all of which collapse to `{ mode: "deny_all" }` unless a valid allowlist
 * object is supplied. Never widens consent: anything unrecognized → deny_all.
 */
export function normalizeNetworkPolicy(value: unknown): NetworkPolicy {
  if (value === "deny_all" || value === undefined || value === null) {
    return { mode: "deny_all" };
  }
  const parsed = networkPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : { mode: "deny_all" };
}

/**
 * Phase A scope: a per-run ephemeral workspace the run may read + write.
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical).
 */
export const approvalScopeSchema = contractsApprovalScopeSchema;
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

/**
 * A standing approval: the user's pre-authorization for autonomous runs of a
 * specific kit. The toolAllowlist is the consent surface — the run may only use
 * tools in this list (further intersected with the kit's declared tools and the
 * Phase A sandbox tool set).
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical). The
 * composite schema is imported directly so its internal references (kitRef,
 * scope, networkPolicy) stay consistent with the contracts package.
 */
export const autoApprovalSchema = contractsAutoApprovalSchema;

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
// Delivery (Phase D — opt-in result delivery)
// ---------------------------------------------------------------------------

/**
 * Opt-in result delivery for a run (Phase D). When a run reaches a TERMINAL
 * status (success OR failure), the worker delivers a notification through each
 * configured channel. Delivery is best-effort: a delivery failure NEVER fails
 * the run — it is logged + audited only.
 *
 *   - `email`: a list of recipient addresses (basic-format validated). Delivered
 *     via the injected `EmailSender` port (SES on AWS; no-op self-host until SMTP
 *     is wired). If SES_SENDER is unset on the aws adapter, email is an inert
 *     no-op so missing config never breaks a run.
 *   - `webhook`: an https endpoint the user owns. A signed JSON POST is sent to
 *     `url`; when `secret` is present the body is HMAC-SHA256 signed and the hex
 *     digest is sent as `X-AutoDelivery-Signature: sha256=<hmac>`. The
 *     destination is SSRF-guarded exactly like the http_fetch tool (https-only,
 *     DNS-resolved, private/loopback/link-local/metadata ranges rejected) — the
 *     guard, NOT an allowlist, is the protection (the url is the user's own).
 *
 * Both channels are optional; absent `deliveryConfig` (or an empty object) means
 * NO delivery. Backward compatible: pre-Phase-D records carry no deliveryConfig.
 */
export const deliveryWebhookSchema = z.object({
  /** Destination URL. MUST be https (validated). */
  url: z.string().url(),
  /** Optional HMAC-SHA256 signing secret. Absent → the payload is sent unsigned. */
  secret: z.string().min(1).optional(),
});
export type DeliveryWebhook = z.infer<typeof deliveryWebhookSchema>;

export const deliveryConfigSchema = z
  .object({
    /** Recipient email addresses (basic-format validated). */
    email: z.array(z.string().email()).optional(),
    /** A signed-webhook destination. */
    webhook: deliveryWebhookSchema.optional(),
  })
  .strict();
export type DeliveryConfig = z.infer<typeof deliveryConfigSchema>;

/** Per-channel delivery outcome status. */
export type DeliveryChannelStatus = "delivered" | "failed" | "skipped";

/** The outcome of one channel's delivery attempt. */
export interface DeliveryChannelOutcome {
  status: DeliveryChannelStatus;
  /** Failure / skip detail (absent on a clean delivery). */
  error?: string;
}

/** The aggregate per-channel result of `deliverResult`. */
export interface DeliveryOutcome {
  email?: DeliveryChannelOutcome;
  webhook?: DeliveryChannelOutcome;
}

/**
 * Validates a delivery config beyond the schema's structural checks:
 *   - every email address is basic-format (the schema already enforces this);
 *   - the webhook url, when present, is https (NOT just a valid URL).
 * Returns the parsed config, or throws a descriptive Error. Treats `undefined`
 * as "no delivery" (returns undefined).
 */
export function validateDeliveryConfig(value: unknown): DeliveryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = deliveryConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid deliveryConfig: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const config = parsed.data;
  if (config.webhook) {
    let url: URL;
    try {
      url = new URL(config.webhook.url);
    } catch {
      throw new Error(`Invalid deliveryConfig: webhook url is not a valid URL.`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`Invalid deliveryConfig: webhook url must be https (got ${url.protocol}).`);
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Shape now sourced from @agentkitforge/contracts (provably identical). */
export const autoRunStatusSchema = contractsAutoRunStatusSchema;
export type AutoRunStatus = z.infer<typeof autoRunStatusSchema>;

/**
 * A per-run input file the user supplies (seeded into the workspace).
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical).
 */
export const autoRunInputFileSchema = contractsAutoRunInputFileSchema;
export type AutoRunInputFile = z.infer<typeof autoRunInputFileSchema>;

/** Shape now sourced from @agentkitforge/contracts (provably identical). */
export const autoRunInputSchema = contractsAutoRunInputSchema;
export type AutoRunInput = z.infer<typeof autoRunInputSchema>;

/**
 * A manifest entry for a per-run input file staged OUT-OF-BAND (Phase C user
 * inputs). Unlike `AutoRunInputFile` (inline content), these reference content
 * staged in the InputStore (S3 / local disk / MinIO) and are hydrated into the
 * run workspace's `inputs/` subdir by the worker before execution.
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical).
 */
export const autoRunInputFileRefSchema = contractsAutoRunInputFileRefSchema;
export type AutoRunInputFileRef = z.infer<typeof autoRunInputFileRefSchema>;

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
 *
 * Type now sourced from @agentkitforge/contracts (identical union).
 */
export type InferenceMode = ContractsInferenceMode;

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
 *   - "webhook": the run was created by an inbound webhook fire (Phase C) on
 *     behalf of a standing AutoWebhook. Also carries `webhookId`.
 *
 * Defaults to "on_demand" for back-compat with pre-Phase-B run records that
 * carry neither `trigger` nor `scheduleId`.
 *
 * Type now sourced from @agentkitforge/contracts (identical union).
 */
export type RunTrigger = ContractsRunTrigger;

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
   * back-compat). "schedule" runs also carry `scheduleId`; "webhook" runs also
   * carry `webhookId`.
   */
  trigger?: RunTrigger;
  /** The AutoSchedule that produced this run (set iff trigger === "schedule"). */
  scheduleId?: string;
  /** The AutoWebhook that produced this run (set iff trigger === "webhook"). */
  webhookId?: string;
  /**
   * Manifest of per-run input files staged out-of-band (Phase C). Hydrated into
   * the workspace `inputs/` subdir by the worker before execution. Distinct from
   * `input.files` (inline content seeded at workspace root).
   */
  inputFiles?: AutoRunInputFileRef[];
  /**
   * Opt-in result delivery (Phase D). When set, the worker delivers a
   * notification through each configured channel after the run reaches a
   * terminal status (success OR failure). Absent = no delivery. Best-effort: a
   * delivery failure never fails the run.
   */
  deliveryConfig?: DeliveryConfig;
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
  /** The AutoWebhook that produced this run (only with trigger "webhook"). */
  webhookId?: string;
  /** Out-of-band staged input-file manifest (Phase C). Hydrated by the worker. */
  inputFiles?: AutoRunInputFileRef[];
  /** Opt-in result delivery (Phase D). Absent = no delivery. */
  deliveryConfig?: DeliveryConfig;
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
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical). The
 * composite schema is imported directly so its internal references (kitRef,
 * input, inferenceMode) stay consistent with the contracts package.
 */
export const autoScheduleSchema = contractsAutoScheduleSchema;

/**
 * The standing-schedule record, extended (Phase D) with an OPTIONAL
 * `deliveryConfig` carried alongside the contracts-derived shape. The config is
 * COPIED onto every run a schedule fires (the web layer / createAndDispatch
 * reads it and threads it into CreateRunInput). The contracts schema parses in
 * "strip" mode, so an unknown `deliveryConfig` is tolerated on the wire; this
 * type makes it first-class for consumers. Backward compatible (optional).
 */
export type AutoSchedule = z.infer<typeof autoScheduleSchema> & {
  deliveryConfig?: DeliveryConfig;
};

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
  /** Opt-in result delivery (Phase D), copied onto each run this schedule fires. */
  deliveryConfig?: DeliveryConfig;
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
  /** Opt-in result delivery (Phase D); pass to add/replace, null to clear. */
  deliveryConfig?: DeliveryConfig | null;
  /** Always stamped by the caller. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Webhooks (Phase C — inbound event triggers)
// ---------------------------------------------------------------------------

/**
 * A standing webhook trigger: an inbound HTTP fire (from a third-party service)
 * creates one autonomous run of a kit, under an existing standing AutoApproval,
 * bounded by a REQUIRED per-fire budget.
 *
 * SECRET HANDLING: the webhook is authenticated by a shared secret. We store
 * ONLY a sha256 hex HASH of that secret (`secretHash`) — never the plaintext.
 * The web layer generates a random secret at creation, shows it to the user
 * ONCE, and persists only the hash. `consumeWebhook` verifies a presented
 * secret with a constant-time compare against the stored hash.
 *
 * SAFETY: a webhook does NOT widen consent. Each fire is still gated by the
 * referenced approval (the gate matches on (userId, kitRef) like an on-demand
 * run) and `budgetCents <= approval.maxBudgetCents`.
 *
 * Shape now sourced from @agentkitforge/contracts (provably identical). The
 * composite schema is imported directly so its internal references (kitRef,
 * inferenceMode) stay consistent with the contracts package.
 */
export const autoWebhookSchema = contractsAutoWebhookSchema;

/**
 * The standing-webhook record, extended (Phase D) with an OPTIONAL
 * `deliveryConfig` carried alongside the contracts-derived shape. The config is
 * COPIED onto every run an inbound fire creates (the web layer /
 * createAndDispatch reads it and threads it into CreateRunInput). The contracts
 * schema parses in "strip" mode, so an unknown `deliveryConfig` is tolerated on
 * the wire; this type makes it first-class for consumers. Backward compatible.
 */
export type AutoWebhook = z.infer<typeof autoWebhookSchema> & {
  deliveryConfig?: DeliveryConfig;
};

export interface CreateWebhookInput {
  userId: string;
  kitRef: KitRef;
  approvalId: string;
  budgetCents: number;
  model: string;
  inferenceMode?: InferenceMode;
  /** Defaults to true (enabled) when omitted. */
  enabled?: boolean;
  /** sha256 hex of the secret. The web layer generates + hashes the plaintext. */
  secretHash: string;
  createdAt: string;
  /** Opt-in result delivery (Phase D), copied onto each run an inbound fire creates. */
  deliveryConfig?: DeliveryConfig;
}

/** The fields recordFire stamps after a webhook successfully creates a run. */
export interface WebhookFireResult {
  /** When the webhook fired (ISO). */
  lastFiredAt: string;
  /** Run id produced by the fire. */
  lastRunId: string;
  /** Fire error, or null when the fire was clean. */
  lastError: string | null;
}
