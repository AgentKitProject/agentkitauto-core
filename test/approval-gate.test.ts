/**
 * Approval gate (via processAutoRun): a run is permitted ONLY if a matching,
 * non-revoked approval exists AND run.budgetCents <= approval.maxBudgetCents.
 *
 * Asserts the gate rejects:
 *   - no approval for the kit,
 *   - approval for a DIFFERENT kit (mismatch),
 *   - budget over the approval ceiling,
 *   - a revoked approval,
 * and that it permits a valid run (which then completes through the driver).
 */

import { describe, expect, it } from "vitest";
import {
  processAutoRun,
  ApprovalDeniedError,
  type ResolveKitContext,
} from "../src/entrypoints/worker.js";
import type { AutoStorageDeps } from "../src/core/ports.js";
import type { CreditLedgerRepository } from "@agentkitforge/gateway-core";
import {
  FakeChatProvider,
  InMemoryRunRepo,
  InMemoryWorkspace,
  noopNow,
  textResponse,
} from "./fakes.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { InMemoryScheduleRepo } from "./schedule-repo-fake.js";
import { InMemoryWebhookRepo } from "./webhook-repo-fake.js";
import { LocalInputStore } from "../src/core/input-store.js";

class FundedLedger implements CreditLedgerRepository {
  async getAccount() {
    return { userId: "u1", availableBalanceCents: 1_000_000, heldBalanceCents: 0, lifetimeTopupCents: 0, updatedAt: noopNow() };
  }
  async ensureAccount() {
    return this.getAccount();
  }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: noopNow() };
  }
  async topup() {
    return this.getAccount();
  }
  async debit() {
    return this.getAccount();
  }
  async reserveHold() {
    return "h-1";
  }
  async settleHold() {
    return this.getAccount();
  }
  async releaseHold() {
    return this.getAccount();
  }
  async getHold() {
    return undefined;
  }
  async listTransactions() {
    return [];
  }
}

const resolveKitContext: ResolveKitContext = async () => ({
  systemPrompt: "sys",
  tools: [],
  toolNames: [],
});

async function harness() {
  const runs = new InMemoryRunRepo();
  const approvals = new InMemoryApprovalRepo();
  const workspaces = new InMemoryWorkspace();
  const schedules = new InMemoryScheduleRepo();
  const webhooks = new InMemoryWebhookRepo();
  const inputs = new LocalInputStore();
  const storage: AutoStorageDeps = { runs, approvals, workspaces, schedules, webhooks, inputs };
  const deps = {
    storage,
    chatProvider: new FakeChatProvider([textResponse("done")]),
    ledger: new FundedLedger(),
    resolveKitContext,
    now: noopNow,
  };
  return { runs, approvals, workspaces, deps };
}

describe("approval gate (processAutoRun)", () => {
  it("rejects when no approval exists", async () => {
    const { runs, deps } = await harness();
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
    });
    await expect(processAutoRun(run.id, deps)).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect((await runs.getRun(run.id))?.status).toBe("failed");
  });

  it("rejects on kit mismatch", async () => {
    const { runs, approvals, deps } = await harness();
    await approvals.createApproval({
      userId: "u1",
      kitRef: { source: "local", localKitId: "OTHER" },
      toolAllowlist: ["read_file"],
      maxBudgetCents: 1000,
      createdAt: noopNow(),
    });
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
    });
    await expect(processAutoRun(run.id, deps)).rejects.toBeInstanceOf(ApprovalDeniedError);
  });

  it("rejects when budget exceeds the approval ceiling", async () => {
    const { runs, approvals, deps } = await harness();
    await approvals.createApproval({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      toolAllowlist: ["read_file"],
      maxBudgetCents: 50,
      createdAt: noopNow(),
    });
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100, // > ceiling 50
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
    });
    await expect(processAutoRun(run.id, deps)).rejects.toThrow(/ceiling/i);
  });

  it("rejects a revoked approval", async () => {
    const { runs, approvals, deps } = await harness();
    const appr = await approvals.createApproval({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      toolAllowlist: ["read_file"],
      maxBudgetCents: 1000,
      createdAt: noopNow(),
    });
    await approvals.revokeApproval(appr.id, noopNow());
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
    });
    await expect(processAutoRun(run.id, deps)).rejects.toBeInstanceOf(ApprovalDeniedError);
  });

  it("permits a valid run and completes it", async () => {
    const { runs, approvals, deps } = await harness();
    await approvals.createApproval({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      toolAllowlist: ["read_file"],
      maxBudgetCents: 1000,
      createdAt: noopNow(),
    });
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
    });
    const out = await processAutoRun(run.id, deps);
    expect(out.status).toBe("succeeded");
    expect((await runs.getRun(run.id))?.status).toBe("succeeded");
  });
});
