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
  AutoRunResult,
  AutoRunStatus,
  CreateApprovalInput,
  CreateRunInput,
  KitRef,
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
}
