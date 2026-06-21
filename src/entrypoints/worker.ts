/**
 * processAutoRun — the runtime-agnostic worker that executes one autonomous run
 * end to end. This is the function a Fargate task / k8s Job / in-process dev
 * runner invokes. It contains NO AWS-specific dispatch (no SQS/Lambda glue) —
 * the caller is responsible for getting a runId here.
 *
 * Sequence:
 *   1. load the run; require status "queued".
 *   2. resolve the standing approval and ENFORCE the approval gate:
 *        - a non-revoked approval for (userId, kitRef) must exist;
 *        - run.budgetCents <= approval.maxBudgetCents.
 *      (kit mismatch / no approval / over-ceiling → run marked failed.)
 *   3. resolve kit context (system prompt + tools) via an injected hook, so this
 *      package never hard-depends on web-forge / a KitStore.
 *   4. create the workspace, seed input files, build the sandbox executor.
 *   5. runAutoRun (the driver does budget + cancel guards + billing reuse).
 *   6. cleanup the workspace.
 */

import type { ChatProvider, CreditLedgerRepository, ToolDefinition } from "@agentkitforge/gateway-core";
import type { AutoStorageDeps, EmailSender } from "../core/ports.js";
import type { AutoApproval, AutoRun, InferenceMode } from "../core/types.js";
import { makeSandboxExecutor } from "../core/sandbox-executor.js";
import { runAutoRun, type RunAutoRunResult } from "../core/run-driver.js";
import { deliverResult } from "../core/delivery.js";
import type { DnsResolver, FetchFn } from "../core/http-fetch.js";

/** The kit context the run needs: a system prompt + the tools the kit declares. */
export interface ResolvedKitContext {
  /** Rendered kit context / system prompt injected as the system message. */
  systemPrompt?: string;
  kitContext?: string;
  /** Tools the kit declares (Anthropic tool-definition shape). */
  tools: ToolDefinition[];
  /** Tool names the kit declares (used to intersect with the approval). */
  toolNames: string[];
}

/** Hook that resolves a run's kit context. Injected; no hard web-forge dep. */
export type ResolveKitContext = (run: AutoRun, approval: AutoApproval) => Promise<ResolvedKitContext>;

export interface ProcessAutoRunDeps {
  storage: AutoStorageDeps;
  /**
   * Provider used for inference. In MANAGED mode this is the platform-key
   * provider (gateway-core). In BYO mode it is the user-key provider; pass it
   * here (or via byoChatProvider) and set inferenceMode "byo".
   */
  chatProvider: ChatProvider;
  /**
   * Optional BYO provider (user's own key). When the run's inferenceMode is
   * "byo" this provider is used instead of `chatProvider`; the credit ledger is
   * NOT debited for inference. Falls back to `chatProvider` if unset.
   */
  byoChatProvider?: ChatProvider;
  /** The gateway credit ledger (gateway-core). */
  ledger: CreditLedgerRepository;
  /** Resolves kit context for the run (system prompt + tools). */
  resolveKitContext: ResolveKitContext;
  /** Clock — ISO 8601. */
  now: () => string;
  /**
   * Inference billing mode override. When omitted, the run record's
   * `inferenceMode` is used (default "managed"). Markup applies in managed mode.
   */
  inferenceMode?: InferenceMode;
  /** Markup in bps for managed turns (Auto's own rate, e.g. 2500). */
  markupBps?: number;
  maxTokens?: number;
  maxToolRounds?: number;
  /**
   * Opt-in result delivery (Phase D). When a run carries a `deliveryConfig`,
   * these deps are used AFTER the run reaches a terminal status to notify the
   * user. Delivery is best-effort — a failure here NEVER fails the run.
   *   - `emailSender`: provider-specific (SES on aws / no-op self-host). When
   *     omitted, email channels are skipped.
   *   - `deliveryFetch` + `deliveryResolver`: the webhook POST + its SSRF guard.
   *     When either is omitted, webhook channels are skipped.
   */
  emailSender?: EmailSender;
  deliveryFetch?: FetchFn;
  deliveryResolver?: DnsResolver;
}

/** Raised + recorded when the approval gate denies a run. */
export class ApprovalDeniedError extends Error {
  readonly name = "ApprovalDeniedError";
}

export async function processAutoRun(
  runId: string,
  deps: ProcessAutoRunDeps,
): Promise<RunAutoRunResult> {
  const { storage, now } = deps;
  const { runs, approvals, workspaces, inputs } = storage;

  const run = await runs.getRun(runId);
  if (!run) throw new Error(`Auto run not found: ${runId}`);

  // ---- Approval gate ------------------------------------------------------
  const approval = await approvals.getApprovalForKit(run.userId, run.kitRef);
  const denyAndFail = async (reason: string): Promise<never> => {
    await runs.updateRunStatus(runId, "failed", { finishedAt: now(), error: reason });
    throw new ApprovalDeniedError(reason);
  };
  if (!approval) {
    await denyAndFail("No standing approval exists for this kit.");
  }
  const appr = approval as AutoApproval;
  if (appr.revokedAt !== null) {
    await denyAndFail("The standing approval for this kit has been revoked.");
  }
  if (run.budgetCents > appr.maxBudgetCents) {
    await denyAndFail(
      `Run budget (${run.budgetCents}¢) exceeds the approval ceiling (${appr.maxBudgetCents}¢).`,
    );
  }

  // ---- Resolve kit context ------------------------------------------------
  const kit = await deps.resolveKitContext(run, appr);

  // ---- Billing mode + provider selection ---------------------------------
  const inferenceMode: InferenceMode =
    deps.inferenceMode ?? run.inferenceMode ?? "managed";
  const inferenceProvider =
    inferenceMode === "byo" && deps.byoChatProvider
      ? deps.byoChatProvider
      : deps.chatProvider;

  // ---- Workspace + executor ----------------------------------------------
  const workspaceId = await workspaces.createWorkspace(run.id);
  await runs.updateRunStatus(runId, "running", { startedAt: now(), workspaceId });
  const runWithWs: AutoRun = { ...run, status: "running", workspaceId };

  try {
    // Seed inline input files into the workspace root (Phase A).
    for (const f of run.input.files ?? []) {
      await workspaces.writeFile(workspaceId, f.path, f.content);
    }

    // Hydrate out-of-band staged input files into the workspace `inputs/` subdir
    // (Phase C). Path-confined by the InputStore + WorkspaceStore. A staged file
    // that is missing/unreadable is skipped by the store (best-effort), so a
    // partial manifest never aborts the run.
    if (run.inputFiles && run.inputFiles.length > 0) {
      await inputs.hydrateInputsIntoWorkspace(run.id, workspaces, workspaceId, run.inputFiles);
    }

    const executeTool = makeSandboxExecutor({
      workspace: workspaces,
      workspaceId,
      runId: run.id,
      approval: appr,
      repo: runs,
      resolvedTools: kit.toolNames,
      now,
    });

    const result = await runAutoRun({
      run: runWithWs,
      approval: appr,
      ...(kit.systemPrompt !== undefined ? { systemPrompt: kit.systemPrompt } : {}),
      ...(kit.kitContext !== undefined ? { kitContext: kit.kitContext } : {}),
      tools: kit.tools,
      executeTool,
      deps: {
        chatProvider: inferenceProvider,
        ledger: deps.ledger,
        runs,
        workspace: workspaces,
        now,
        inferenceMode,
        ...(deps.markupBps !== undefined ? { markupBps: deps.markupBps } : {}),
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      },
      ...(deps.maxToolRounds !== undefined ? { maxToolRounds: deps.maxToolRounds } : {}),
    });

    // ---- Opt-in result delivery (Phase D) --------------------------------
    // Fires AFTER the run reaches a terminal status (success OR failure — the
    // user wants to be notified of failures too). Best-effort: any delivery
    // failure is logged + audited inside deliverResult, never fatal to the run.
    if (run.deliveryConfig) {
      try {
        await deliverResult({
          run: { ...runWithWs, status: result.status, finishedAt: now() },
          result: {
            status: result.status,
            output: result.result?.output ?? "",
            spentCents: result.spentCents,
          },
          config: run.deliveryConfig,
          deps: {
            runs,
            ...(deps.emailSender ? { emailSender: deps.emailSender } : {}),
            ...(deps.deliveryFetch ? { fetchFn: deps.deliveryFetch } : {}),
            ...(deps.deliveryResolver ? { resolver: deps.deliveryResolver } : {}),
          },
          now,
        });
      } catch (err) {
        // Defensive: deliverResult is contracted not to throw, but never let a
        // delivery hiccup mask the run's real terminal result.
        console.error(
          `Auto run ${run.id} delivery error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  } finally {
    // Ephemeral workspace — always cleaned up after the run resolves.
    await workspaces.cleanup(workspaceId).catch(() => {});
  }
}
