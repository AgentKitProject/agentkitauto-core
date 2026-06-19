/**
 * The webhook consumer (Phase C).
 *
 * `consumeWebhook` is what an inbound HTTP route invokes when a third-party
 * service fires a configured webhook. It:
 *   1. looks up the webhook (typed error if missing/disabled);
 *   2. authenticates the presented secret via a CONSTANT-TIME hash compare
 *      against the stored sha256 hash (typed error on mismatch);
 *   3. re-checks the standing approval through the SAME Phase A gate semantics
 *      (non-revoked approval for (userId, kitRef) exists AND budgetCents <=
 *      approval.maxBudgetCents) — a webhook never widens consent;
 *   4. builds a CreateRunInput (trigger "webhook", webhookId set, payload folded
 *      into the run input) and dispatches via an INJECTED createAndDispatch, so
 *      this package never hard-depends on the web-forge run-create + Fargate
 *      path (core stays runtime-agnostic, exactly like the Phase B scheduler);
 *   5. records the fire (lastFiredAt / lastRunId / ++fireCount) and returns the
 *      created run.
 *
 * Deterministic: `now` is threaded; no argless Date.
 */

import type { AutoApprovalRepository, AutoWebhookRepository } from "./ports.js";
import type { AutoRun, AutoWebhook, CreateRunInput } from "./types.js";
import { verifyWebhookSecret } from "./webhook-secret.js";

/** Typed failure modes for a webhook consume attempt. */
export type WebhookErrorReason =
  | "not_found"
  | "disabled"
  | "bad_secret"
  | "approval_invalid"
  | "over_budget";

/** Raised when a webhook fire is rejected (auth/gate). Carries a typed reason. */
export class WebhookError extends Error {
  readonly name = "WebhookError";
  constructor(
    readonly reason: WebhookErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Injected run-create + dispatch for a webhook fire. Given the fully-built
 * CreateRunInput, it must create the AutoRun and dispatch it onto the same
 * execution path on-demand runs use, then return the created run. Mirrors the
 * Phase B scheduler's CreateAndDispatch (kept injected, never hard-depended on).
 */
export type CreateAndDispatchWebhookRun = (input: CreateRunInput) => Promise<AutoRun>;

export interface ConsumeWebhookArgs {
  deps: {
    webhooks: AutoWebhookRepository;
    approvals: AutoApprovalRepository;
  };
  webhookId: string;
  /** The plaintext secret presented by the caller (e.g. a header/query param). */
  providedSecret: string;
  /** The inbound JSON payload (folded into the run input). */
  payload?: unknown;
  /** Clock — ISO 8601. Threaded; never argless Date. */
  now: string;
  /** Creates + dispatches the run for this fire (see CreateAndDispatchWebhookRun). */
  createAndDispatch: CreateAndDispatchWebhookRun;
}

/**
 * Re-checks the webhook against the standing approval (the Phase A gate),
 * mirroring processAutoRun / the Phase B scheduler:
 *   - a non-revoked approval for (userId, kitRef) must exist;
 *   - budgetCents <= approval.maxBudgetCents.
 * Throws a typed WebhookError on failure.
 */
async function assertApprovalGate(
  webhook: AutoWebhook,
  approvals: AutoApprovalRepository,
): Promise<void> {
  const approval = await approvals.getApprovalForKit(webhook.userId, webhook.kitRef);
  // getApprovalForKit returns only non-revoked rows, so missing === no valid
  // approval (revoked or never created) — same as the scheduler.
  if (!approval) {
    throw new WebhookError(
      "approval_invalid",
      "No standing approval exists for this kit.",
    );
  }
  if (webhook.budgetCents > approval.maxBudgetCents) {
    throw new WebhookError(
      "over_budget",
      `Webhook budget (${webhook.budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`,
    );
  }
}

/**
 * Derives the run's prompt from the webhook payload. If the payload is a string
 * we use it directly; if it is an object with a string `text`/`prompt` we use
 * that; otherwise the prompt is a fixed marker and the structured payload is
 * surfaced via `input.event` for the kit to read.
 */
function promptFromPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === "string") return text;
    const prompt = (payload as { prompt?: unknown }).prompt;
    if (typeof prompt === "string") return prompt;
  }
  return "Process the inbound webhook event (see input.event).";
}

/**
 * Authenticate + fire a webhook. Returns the created AutoRun on success; throws
 * a typed WebhookError on any rejection (the HTTP route maps reason → status).
 */
export async function consumeWebhook(args: ConsumeWebhookArgs): Promise<AutoRun> {
  const { deps, webhookId, providedSecret, payload, now, createAndDispatch } = args;
  const { webhooks, approvals } = deps;

  const webhook = await webhooks.getWebhook(webhookId);
  if (!webhook) {
    throw new WebhookError("not_found", "Webhook not found.");
  }
  if (!webhook.enabled) {
    throw new WebhookError("disabled", "Webhook is disabled.");
  }

  // Constant-time secret verification against the stored hash.
  if (!verifyWebhookSecret(providedSecret, webhook.secretHash)) {
    throw new WebhookError("bad_secret", "Invalid webhook secret.");
  }

  // Re-check the standing approval + budget (reuse the Phase A gate).
  await assertApprovalGate(webhook, approvals);

  // Build the run input: fold the payload into the input (prompt + structured
  // event). Inline files are never seeded from a webhook payload (untrusted).
  const createInput: CreateRunInput = {
    userId: webhook.userId,
    kitRef: webhook.kitRef,
    input: {
      prompt: promptFromPayload(payload),
      ...(payload !== undefined ? { event: payload } : {}),
    },
    budgetCents: webhook.budgetCents,
    model: webhook.model,
    createdAt: now,
    ...(webhook.inferenceMode !== undefined ? { inferenceMode: webhook.inferenceMode } : {}),
    trigger: "webhook",
    webhookId: webhook.id,
  };

  const run = await createAndDispatch(createInput);

  // Record the fire (idempotent-ish: ++fireCount, stamp lastFiredAt/lastRunId).
  await webhooks.recordFire(webhook.id, {
    lastFiredAt: now,
    lastRunId: run.id,
    lastError: null,
  });

  return run;
}
