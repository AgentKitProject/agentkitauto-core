/**
 * consumeWebhook (Phase C): authenticate an inbound fire, re-check the Phase A
 * approval gate, dispatch a run with trigger="webhook"+webhookId, record the
 * fire. Deterministic + offline (createAndDispatch + now are injected).
 */

import { describe, expect, it } from "vitest";
import { consumeWebhook, WebhookError } from "../src/core/webhook-runner.js";
import { hashWebhookSecret } from "../src/core/webhook-secret.js";
import type { AutoRun, AutoWebhook, CreateRunInput, KitRef } from "../src/core/types.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { InMemoryWebhookRepo } from "./webhook-repo-fake.js";

const NOW = "2026-06-19T12:00:00.000Z";
const KIT: KitRef = { source: "local", localKitId: "k1" };
const SECRET = "top-secret-webhook-value";

function makeWebhook(over: Partial<AutoWebhook> = {}): AutoWebhook {
  return {
    id: "wh-1",
    userId: "u1",
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 100,
    model: "claude-sonnet-4-6",
    enabled: true,
    secretHash: hashWebhookSecret(SECRET),
    createdAt: NOW,
    lastFiredAt: null,
    lastRunId: null,
    lastError: null,
    fireCount: 0,
    ...over,
  };
}

async function seedApproval(approvals: InMemoryApprovalRepo, maxBudgetCents = 1000): Promise<void> {
  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: ["read_file", "write_file"],
    maxBudgetCents,
    createdAt: NOW,
  });
}

/** A recording dispatcher that builds a fake AutoRun from the CreateRunInput. */
function makeDispatcher(): {
  fn: (input: CreateRunInput) => Promise<AutoRun>;
  inputs: CreateRunInput[];
} {
  const inputs: CreateRunInput[] = [];
  return {
    inputs,
    fn: async (input: CreateRunInput): Promise<AutoRun> => {
      inputs.push(input);
      return {
        id: "run-dispatched-1",
        userId: input.userId,
        kitRef: input.kitRef,
        status: "queued",
        input: input.input,
        budgetCents: input.budgetCents,
        spentCents: 0,
        model: input.model,
        createdAt: input.createdAt,
        auditLog: [],
        trigger: input.trigger,
        ...(input.webhookId ? { webhookId: input.webhookId } : {}),
      };
    },
  };
}

describe("consumeWebhook", () => {
  it("authenticates, dispatches a webhook-trigger run, and records the fire", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo();
    webhooks.seed(makeWebhook());
    await seedApproval(approvals);
    const dispatcher = makeDispatcher();

    const run = await consumeWebhook({
      deps: { webhooks, approvals },
      webhookId: "wh-1",
      providedSecret: SECRET,
      payload: { text: "do the thing", extra: 42 },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });

    // Dispatched with webhook trigger + webhookId + folded payload.
    expect(dispatcher.inputs).toHaveLength(1);
    const ci = dispatcher.inputs[0]!;
    expect(ci.trigger).toBe("webhook");
    expect(ci.webhookId).toBe("wh-1");
    expect(ci.budgetCents).toBe(100);
    expect(ci.input.prompt).toBe("do the thing");
    expect(ci.input.event).toEqual({ text: "do the thing", extra: 42 });

    expect(run.id).toBe("run-dispatched-1");
    expect(run.trigger).toBe("webhook");

    // Fire recorded: ++fireCount, lastRunId + lastFiredAt stamped, no error.
    const after = await webhooks.getWebhook("wh-1");
    expect(after?.fireCount).toBe(1);
    expect(after?.lastRunId).toBe("run-dispatched-1");
    expect(after?.lastFiredAt).toBe(NOW);
    expect(after?.lastError).toBeNull();
  });

  it("derives a marker prompt + event when the payload is not text-shaped", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo();
    webhooks.seed(makeWebhook());
    await seedApproval(approvals);
    const dispatcher = makeDispatcher();

    await consumeWebhook({
      deps: { webhooks, approvals },
      webhookId: "wh-1",
      providedSecret: SECRET,
      payload: { id: 9, action: "push" },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });
    const ci = dispatcher.inputs[0]!;
    expect(ci.input.prompt).toMatch(/input\.event/);
    expect(ci.input.event).toEqual({ id: 9, action: "push" });
  });

  it("rejects a missing webhook with reason not_found (no dispatch)", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo();
    const dispatcher = makeDispatcher();
    await expect(
      consumeWebhook({
        deps: { webhooks, approvals },
        webhookId: "nope",
        providedSecret: SECRET,
        now: NOW,
        createAndDispatch: dispatcher.fn,
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(dispatcher.inputs).toHaveLength(0);
  });

  it("rejects a disabled webhook with reason disabled (no dispatch)", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo();
    webhooks.seed(makeWebhook({ enabled: false }));
    await seedApproval(approvals);
    const dispatcher = makeDispatcher();
    await expect(
      consumeWebhook({
        deps: { webhooks, approvals },
        webhookId: "wh-1",
        providedSecret: SECRET,
        now: NOW,
        createAndDispatch: dispatcher.fn,
      }),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(dispatcher.inputs).toHaveLength(0);
  });

  it("rejects a bad secret with reason bad_secret (no dispatch)", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo();
    webhooks.seed(makeWebhook());
    await seedApproval(approvals);
    const dispatcher = makeDispatcher();
    const err = await consumeWebhook({
      deps: { webhooks, approvals },
      webhookId: "wh-1",
      providedSecret: "WRONG",
      now: NOW,
      createAndDispatch: dispatcher.fn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookError);
    expect(err.reason).toBe("bad_secret");
    expect(dispatcher.inputs).toHaveLength(0);
  });

  it("rejects when no standing approval exists (approval_invalid)", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo(); // none seeded
    webhooks.seed(makeWebhook());
    const dispatcher = makeDispatcher();
    await expect(
      consumeWebhook({
        deps: { webhooks, approvals },
        webhookId: "wh-1",
        providedSecret: SECRET,
        now: NOW,
        createAndDispatch: dispatcher.fn,
      }),
    ).rejects.toMatchObject({ reason: "approval_invalid" });
    expect(dispatcher.inputs).toHaveLength(0);
  });

  it("rejects when the fire budget exceeds the approval ceiling (over_budget)", async () => {
    const webhooks = new InMemoryWebhookRepo();
    const approvals = new InMemoryApprovalRepo();
    webhooks.seed(makeWebhook({ budgetCents: 5000 }));
    await seedApproval(approvals, 1000); // ceiling below the fire budget
    const dispatcher = makeDispatcher();
    await expect(
      consumeWebhook({
        deps: { webhooks, approvals },
        webhookId: "wh-1",
        providedSecret: SECRET,
        now: NOW,
        createAndDispatch: dispatcher.fn,
      }),
    ).rejects.toMatchObject({ reason: "over_budget" });
    expect(dispatcher.inputs).toHaveLength(0);
  });
});
