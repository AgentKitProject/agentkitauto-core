/**
 * The autonomous run-driver: drives a kit to completion with NO human in the
 * per-step loop.
 *
 * ENGINE REUSE: this composes @agentkitforge/gateway-core directly. In MANAGED
 * mode each model turn goes through `runManagedTurn`, which performs the
 * two-phase credit hold, makes the provider call with the platform key, and
 * settles the ACTUAL metered cost (with markup) via `computeDebitCents` — Auto
 * does NOT re-implement the chat call, pricing, or billing. The driver only owns
 * the AUTONOMOUS loop (multi-turn tool execution without a confirm dialog) plus
 * the Auto-specific guards: a per-run budget cap and a kill-switch.
 *
 * BILLING MODEL (server-chosen by code path, never client-supplied):
 *   - inferenceMode "managed": platform provider + prepaid credits. Inference is
 *     debited at `markupBps` (Auto's own markup, e.g. 2500 = 25%) per turn. This
 *     is today's path.
 *   - inferenceMode "byo": the caller-supplied BYO ChatProvider (user's key) is
 *     called DIRECTLY — the credit ledger is NOT touched for inference (the user
 *     is billed by their provider). spentInferenceCents stays 0.
 *
 * PER-MINUTE CLOUD-RUN FEE: charged ONLY when
 *   isCloudRun && inferenceMode === "byo" && cloudRunCentsPerMin > 0
 * (we run their job on our compute but collect no inference markup). The run
 * reserves an up-front hold for the estimated minutes derived from the budget
 * (estimatedMin = floor(budgetCents / cloudRunCentsPerMin), which also caps the
 * run's wall-clock), and settles ceil(actual minutes) * cloudRunCentsPerMin at
 * completion / cancel / failure / budget-stop. It uses the SAME
 * CreditLedgerRepository (reserveHold/settleHold) — no separate ledger. For ALL
 * other combinations (managed cloud, local/desktop, self-host) there is NO
 * separate compute debit.
 *
 * Per turn:
 *   1. before the turn — check spentInferenceCents < budgetCents (else
 *      budget_exceeded); check isCancelRequested (else canceled); for cloud BYO
 *      runs, also stop once the metered minutes reach the budget-derived cap.
 *   2. run the turn (managed: runManagedTurn; byo: chatProvider.sendMessage).
 *   3. recordSpend(debitedCents) → new spentInferenceCents; if it reaches the
 *      budget, stop after this turn with budget_exceeded.
 *   4. if the model emitted tool_use → run each through the sandbox executor,
 *      append the results, and loop. Otherwise the run is complete → succeeded.
 *
 * maxToolRounds bounds the loop. Any thrown error → failed.
 */

import {
  runManagedTurn,
  type ChatProvider,
  type CreditLedgerRepository,
  type ChatRequest,
  type ChatResponse,
  type ConversationMessage,
  type ContentBlock,
  type ToolDefinition,
  type ToolUseBlock,
} from "@agentkitforge/gateway-core";

import type { AutoApproval, AutoRun, AutoRunResult, InferenceMode } from "./types.js";
import type { AutoRunRepository, WorkspaceStore } from "./ports.js";
import type { SandboxExecutor } from "./sandbox-executor.js";

/** The terminal outcome of an autonomous run. */
export interface RunAutoRunResult {
  status: "succeeded" | "failed" | "canceled" | "budget_exceeded";
  result?: AutoRunResult;
  error?: string;
  /** Total cents debited across all turns of this run (inference + compute). */
  spentCents: number;
  /** Cents debited for model inference only (0 in BYO mode). */
  spentInferenceCents: number;
  /** Cents debited for the per-minute cloud-run compute fee (BYO cloud only). */
  spentComputeCents: number;
  /** Number of tool-execution rounds driven. */
  toolRounds: number;
}

export interface RunAutoRunDeps {
  /**
   * Provider used for inference. In managed mode this is the PLATFORM (managed)
   * key provider from gateway-core; in BYO mode this is the caller-supplied
   * provider configured with the USER's own key.
   */
  chatProvider: ChatProvider;
  /** The credit ledger backing this deployment — from gateway-core. */
  ledger: CreditLedgerRepository;
  /** Auto run repository (lifecycle, spend, cancel-switch). */
  runs: AutoRunRepository;
  /** The run's workspace, used to bundle the final file manifest. */
  workspace: WorkspaceStore;
  /** Clock — ISO 8601. Also used to meter wall-clock minutes for cloud runs. */
  now: () => string;
  /**
   * Inference billing mode. "managed" (default) debits the ledger per turn at
   * markupBps; "byo" calls chatProvider directly and never debits inference.
   */
  inferenceMode?: InferenceMode;
  /** Markup in bps; forwarded to runManagedTurn (managed mode only). */
  markupBps?: number;
  /** Per-turn max output tokens. Default 4096. */
  maxTokens?: number;
}

export interface RunAutoRunArgs {
  run: AutoRun;
  approval: AutoApproval;
  /** Rendered kit context / system prompt injected as the system message. */
  systemPrompt?: string;
  kitContext?: string;
  /** Tools advertised to the model (Anthropic tool-definition shape). */
  tools: ToolDefinition[];
  /** The sandbox executor (the hands). */
  executeTool: SandboxExecutor;
  deps: RunAutoRunDeps;
  /** Safety bound on tool rounds. Default 64. */
  maxToolRounds?: number;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Wall-clock minutes elapsed between two ISO timestamps (>= 0). */
function elapsedMinutes(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / 60_000;
}

/**
 * Runs a kit autonomously to completion. Returns the terminal outcome; also
 * persists status, spend, result, and audit through the injected repo so the
 * worker/entrypoint can stay thin.
 */
export async function runAutoRun(args: RunAutoRunArgs): Promise<RunAutoRunResult> {
  const { run, tools, executeTool, deps } = args;
  const { chatProvider, ledger, runs, workspace, now } = deps;
  const maxToolRounds = args.maxToolRounds ?? 64;
  const maxTokens = deps.maxTokens ?? 4096;
  const system = args.systemPrompt ?? args.kitContext ?? "";

  const inferenceMode: InferenceMode =
    deps.inferenceMode ?? run.inferenceMode ?? "managed";

  // Workspace id resolved from the run; the worker creates it before this call.
  const workspaceId = run.workspaceId;
  if (!workspaceId) {
    throw new Error("runAutoRun requires run.workspaceId to be set by the worker.");
  }

  // Inference spend is the budget-gated quantity. (In BYO mode it stays 0 — the
  // budget then only bounds the cloud-run minutes below.)
  let spentInferenceCents = run.spentCents;
  let spentComputeCents = 0;
  const budgetCents = run.budgetCents;

  // ---- Per-minute cloud-run compute fee (BYO + cloud only) ------------------
  const cloudRunCentsPerMin = run.cloudRunCentsPerMin ?? 0;
  const chargeCompute =
    run.isCloudRun === true && inferenceMode === "byo" && cloudRunCentsPerMin > 0;
  // Estimated minutes derived from the budget; ALSO caps the run's wall-clock.
  const estimatedMin = chargeCompute
    ? Math.floor(budgetCents / cloudRunCentsPerMin)
    : 0;
  const startedAtIso = now();
  let computeHoldId: string | undefined;

  /** Settle the metered cloud-run minutes (idempotent — runs once). Settles the
   *  up-front hold with ceil(actual minutes) * rate and folds the fee into the
   *  run's persisted total spend. */
  const settleCompute = async (): Promise<void> => {
    if (computeHoldId === undefined) return;
    const holdId = computeHoldId;
    computeHoldId = undefined;
    let minutes = elapsedMinutes(startedAtIso, now());
    if (estimatedMin > 0) minutes = Math.min(minutes, estimatedMin);
    const cents = Math.ceil(minutes) * cloudRunCentsPerMin;
    await ledger.settleHold(holdId, cents, now(), `auto-run:${run.id}:compute`);
    spentComputeCents = cents;
    // Fold the compute fee into the persisted total spend (spentCents = the sum
    // of inference + compute). Inference debits already went through recordSpend.
    if (cents > 0) await runs.recordSpend(run.id, cents);
  };

  // Seed the conversation with the user's task.
  const messages: ConversationMessage[] = [
    { role: "user", content: [{ type: "text", text: run.input.prompt }] },
  ];

  let lastText = "";
  let toolRounds = 0;

  const finalize = async (
    status: RunAutoRunResult["status"],
    extra: { error?: string } = {},
  ): Promise<RunAutoRunResult> => {
    // Settle the cloud-run compute hold on ANY terminal outcome (completion,
    // cancel, failure, budget). Best-effort so a ledger hiccup can't mask the
    // run's real terminal status.
    await settleCompute().catch(() => {});

    let result: AutoRunResult | undefined;
    if (status === "succeeded" || status === "budget_exceeded" || status === "canceled") {
      // Always capture whatever the run produced, even on a partial stop.
      const files = await workspace.bundleResult(workspaceId).catch(() => []);
      result = { output: lastText, files };
      await runs.setResult(run.id, result);
    }
    await runs.updateRunStatus(run.id, status, {
      finishedAt: now(),
      spentInferenceCents,
      spentComputeCents,
      ...(extra.error ? { error: extra.error } : {}),
    });
    return {
      status,
      result,
      error: extra.error,
      spentCents: spentInferenceCents + spentComputeCents,
      spentInferenceCents,
      spentComputeCents,
      toolRounds,
    };
  };

  /** Run one inference turn under the active billing mode; returns response +
   *  the inference cents debited this turn (always 0 in BYO mode). */
  const runTurn = async (
    request: ChatRequest,
  ): Promise<{ response: ChatResponse; debitedCents: number }> => {
    if (inferenceMode === "byo") {
      // BYO: call the user's provider directly. The ledger is NOT touched for
      // inference — the user is billed by their own provider.
      const response = await chatProvider.sendMessage(request);
      return { response, debitedCents: 0 };
    }
    const turn = await runManagedTurn(
      {
        chatProvider,
        ledger,
        now,
        ...(deps.markupBps !== undefined ? { markupBps: deps.markupBps } : {}),
      },
      {
        userId: run.userId,
        request,
        sourceRef: `auto-run:${run.id}`,
      },
    );
    return { response: turn.response, debitedCents: turn.debitedCents };
  };

  try {
    if (chargeCompute) {
      // Reserve the up-front hold for the budget-derived estimated minutes.
      // Insufficient balance → reserveHold throws; the catch below records the
      // run as failed. (web-forge pre-checks this before dispatch for a clean
      // 402, but the worker path is defended here too.)
      await ledger.ensureAccount(run.userId, now());
      const holdCents = estimatedMin * cloudRunCentsPerMin;
      if (holdCents > 0) {
        computeHoldId = await ledger.reserveHold(run.userId, holdCents, now());
      }
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Guard: kill-switch.
      if (await runs.isCancelRequested(run.id)) {
        return await finalize("canceled");
      }
      // Guard: budget cap (before spending more). In managed mode this is the
      // inference spend; in BYO cloud mode budget bounds the compute minutes.
      if (spentInferenceCents >= budgetCents) {
        return await finalize("budget_exceeded");
      }
      // Guard: cloud-run wall-clock cap derived from the budget (BYO cloud only).
      if (chargeCompute && estimatedMin > 0 && elapsedMinutes(startedAtIso, now()) >= estimatedMin) {
        return await finalize("budget_exceeded");
      }

      const request: ChatRequest = {
        model: run.model,
        system,
        messages,
        tools,
        maxTokens,
      };

      const turn = await runTurn(request);

      // Record the actual metered inference spend for this turn (0 for BYO).
      if (turn.debitedCents > 0) {
        spentInferenceCents = await runs.recordSpend(run.id, turn.debitedCents);
      }

      const content = turn.response.content;
      lastText = textOf(content);

      // Append the assistant message to history.
      messages.push({ role: "assistant", content });

      const toolUses = toolUsesOf(content);
      if (turn.response.stopReason !== "tool_use" || toolUses.length === 0) {
        // Natural completion.
        return await finalize("succeeded");
      }

      // Budget exhausted by this turn → stop before running tools / next turn.
      if (spentInferenceCents >= budgetCents) {
        return await finalize("budget_exceeded");
      }

      // Cancel requested mid-flight → stop before executing tools.
      if (await runs.isCancelRequested(run.id)) {
        return await finalize("canceled");
      }

      if (toolRounds >= maxToolRounds) {
        return await finalize("failed", {
          error: `Run exceeded the tool-use round limit (${maxToolRounds}).`,
        });
      }
      toolRounds += 1;

      // Execute each tool_use through the sandbox executor (the hands).
      const resultBlocks: ContentBlock[] = [];
      for (const tu of toolUses) {
        const outcome = await executeTool({
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
        });
        const isError = "error" in outcome && typeof outcome.error === "string";
        const payload = isError
          ? (outcome as { error: string }).error
          : stringifyToolResult((outcome as { result?: unknown }).result);
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: payload,
        });
      }
      messages.push({ role: "user", content: resultBlocks });
    }
  } catch (err) {
    return await finalize("failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result ?? null);
  } catch {
    return String(result);
  }
}
