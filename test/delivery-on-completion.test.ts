/**
 * Delivery-on-completion (Phase D): processAutoRun fires `deliverResult` AFTER a
 * run reaches a terminal status, for BOTH success and failure, and a delivery
 * failure does NOT fail the run. No deliveryConfig → no delivery.
 *
 * Fully offline: fake provider/ledger/storage + injected delivery deps.
 */

import { describe, expect, it } from "vitest";
import { processAutoRun, type ResolveKitContext } from "../src/entrypoints/worker.js";
import type { AutoStorageDeps, EmailSender, OutboundEmail } from "../src/core/ports.js";
import type { DnsResolver, FetchFn } from "../src/core/http-fetch.js";
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
  async ensureAccount() { return this.getAccount(); }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: noopNow() };
  }
  async topup() { return this.getAccount(); }
  async debit() { return this.getAccount(); }
  async reserveHold() { return "h-1"; }
  async settleHold() { return this.getAccount(); }
  async releaseHold() { return this.getAccount(); }
  async getHold() { return undefined; }
  async listTransactions() { return []; }
}

const resolveKitContext: ResolveKitContext = async () => ({ systemPrompt: "sys", tools: [], toolNames: [] });

const publicResolver: DnsResolver = async () => ["93.184.216.34"];

function recordingFetch(): { fn: FetchFn; bodies: string[] } {
  const bodies: string[] = [];
  const fn: FetchFn = async (_url, init) => {
    if (init?.body) bodies.push(init.body);
    return { status: 200, headers: { forEach() {} }, async text() { return "ok"; } };
  };
  return { fn, bodies };
}

async function harness(opts: {
  responses?: ReturnType<typeof textResponse>[];
  fetchFn?: FetchFn;
  resolver?: DnsResolver;
  emailSender?: EmailSender;
}) {
  const runs = new InMemoryRunRepo();
  const approvals = new InMemoryApprovalRepo();
  const workspaces = new InMemoryWorkspace();
  const schedules = new InMemoryScheduleRepo();
  const webhooks = new InMemoryWebhookRepo();
  const inputs = new LocalInputStore();
  const storage: AutoStorageDeps = { runs, approvals, workspaces, schedules, webhooks, inputs };
  await approvals.createApproval({
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    toolAllowlist: ["read_file"],
    maxBudgetCents: 1000,
    createdAt: noopNow(),
  });
  const deps = {
    storage,
    chatProvider: new FakeChatProvider(opts.responses ?? [textResponse("done")]),
    ledger: new FundedLedger(),
    resolveKitContext,
    now: noopNow,
    ...(opts.fetchFn ? { deliveryFetch: opts.fetchFn } : {}),
    ...(opts.resolver ? { deliveryResolver: opts.resolver } : {}),
    ...(opts.emailSender ? { emailSender: opts.emailSender } : {}),
  };
  return { runs, deps };
}

describe("delivery-on-completion (processAutoRun)", () => {
  it("delivers a webhook AFTER a successful run", async () => {
    const { fn, bodies } = recordingFetch();
    const { runs, deps } = await harness({ fetchFn: fn, resolver: publicResolver });
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
      deliveryConfig: { webhook: { url: "https://hooks.example.com/auto", secret: "s" } },
    });
    const out = await processAutoRun(run.id, deps);
    expect(out.status).toBe("succeeded");
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ runId: run.id, status: "succeeded" });
    const audited = (await runs.getRun(run.id))!.auditLog.filter((e) => e.tool === "delivery");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.outcome).toBe("ok");
  });

  it("delivers email AFTER a FAILED run (notify on failure too)", async () => {
    const seen: OutboundEmail[] = [];
    const sender: EmailSender = { async sendEmail(e) { seen.push(e); return { status: "delivered" }; } };
    // A FakeChatProvider with no scripted responses throws → run fails.
    const { runs, deps } = await harness({ responses: [], emailSender: sender });
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
      deliveryConfig: { email: ["owner@example.com"] },
    });
    const out = await processAutoRun(run.id, deps);
    expect(out.status).toBe("failed");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.subject).toMatch(/run failed/);
    expect(seen[0]!.to).toEqual(["owner@example.com"]);
  });

  it("a delivery failure does NOT fail an otherwise-successful run", async () => {
    const fn: FetchFn = async () => { throw new Error("network down"); };
    const { runs, deps } = await harness({ fetchFn: fn, resolver: publicResolver });
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
      deliveryConfig: { webhook: { url: "https://hooks.example.com/auto" } },
    });
    const out = await processAutoRun(run.id, deps);
    expect(out.status).toBe("succeeded"); // run is unaffected
    const audited = (await runs.getRun(run.id))!.auditLog.find((e) => e.tool === "delivery");
    expect(audited?.outcome).toBe("error");
  });

  it("no deliveryConfig → no delivery (no fetch, no audit)", async () => {
    const { fn, bodies } = recordingFetch();
    const { runs, deps } = await harness({ fetchFn: fn, resolver: publicResolver });
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
    expect(bodies).toHaveLength(0);
    const audited = (await runs.getRun(run.id))!.auditLog.filter((e) => e.tool === "delivery");
    expect(audited).toHaveLength(0);
  });
});
