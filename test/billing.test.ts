/**
 * AgentKitAuto billing model — markup + per-minute cloud-run fee.
 *
 * Deterministic + offline: a scripted FakeChatProvider, a funded tracking
 * ledger, and a controllable ISO clock. Asserts:
 *   - managed Auto turns debit inference at AUTO markup (2500), not 1500;
 *   - BYO mode skips the inference debit (ledger inference-untouched);
 *   - cloud + BYO debits the per-minute fee (hold reserved up-front, settled on
 *     completion AND on cancel/failure);
 *   - local + BYO = zero compute debit;
 *   - managed cloud = zero SEPARATE compute debit (only the inference markup).
 */

import { describe, expect, it } from "vitest";
import { computeDebitCents, type CreditLedgerRepository } from "@agentkitforge/gateway-core";
import { runAutoRun } from "../src/core/run-driver.js";
import { makeSandboxExecutor } from "../src/core/sandbox-executor.js";
import type { AutoApproval, AutoRun, InferenceMode } from "../src/core/types.js";
import type { ChatResponse, ContentBlock } from "@agentkitforge/gateway-core";
import {
  FakeChatProvider,
  InMemoryRunRepo,
  InMemoryWorkspace,
  textResponse,
  toolUseResponse,
} from "./fakes.js";

/** A text response with a large, billing-distinguishable token usage. */
function bigTextResponse(text: string): ChatResponse {
  return {
    content: [{ type: "text", text }] as ContentBlock[],
    stopReason: "end_turn",
    usage: BIG_USAGE,
  };
}

const ACCOUNT = {
  userId: "u1",
  availableBalanceCents: 1_000_000,
  heldBalanceCents: 0,
  lifetimeTopupCents: 0,
  updatedAt: "2026-06-18T00:00:00.000Z",
};

interface SettleCall {
  holdId: string;
  cents: number;
  sourceRef?: string;
}

/** Funded ledger that records every reserve/settle so tests can assert the
 *  exact debited amounts (inference markup + compute fee). */
class TrackingLedger implements CreditLedgerRepository {
  reserves: { cents: number }[] = [];
  settles: SettleCall[] = [];
  releases: string[] = [];
  private seq = 0;
  /** When set, reserveHold throws to simulate insufficient funds. */
  rejectReserve = false;

  async getAccount() {
    return ACCOUNT;
  }
  async ensureAccount() {
    return ACCOUNT;
  }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: ACCOUNT.updatedAt };
  }
  async topup() {
    return ACCOUNT;
  }
  async debit() {
    return ACCOUNT;
  }
  async reserveHold(_userId: string, maxCostCents: number) {
    if (this.rejectReserve) throw new Error("condition check failed: balance");
    this.reserves.push({ cents: maxCostCents });
    return `h-${++this.seq}`;
  }
  async settleHold(holdId: string, actualCostCents: number, _now: string, sourceRef?: string) {
    this.settles.push({ holdId, cents: actualCostCents, sourceRef });
    return ACCOUNT;
  }
  async releaseHold(holdId: string) {
    this.releases.push(holdId);
    return ACCOUNT;
  }
  async getHold() {
    return undefined;
  }
  async listTransactions() {
    return [];
  }
}

/** A clock that returns a fixed base time, advanceable by whole minutes. */
function makeClock(baseMs = Date.parse("2026-06-18T00:00:00.000Z")) {
  let offsetMs = 0;
  const now = () => new Date(baseMs + offsetMs).toISOString();
  return { now, advanceMinutes: (m: number) => { offsetMs += m * 60_000; } };
}

const APPROVAL: AutoApproval = {
  id: "appr-1",
  userId: "u1",
  kitRef: { source: "local", localKitId: "k1" },
  scope: "workspace_read_write",
  toolAllowlist: ["write_file"],
  networkPolicy: { mode: "deny_all" },
  maxBudgetCents: 1_000_000,
  createdAt: "2026-06-18T00:00:00.000Z",
  revokedAt: null,
};

async function setup(
  opts: {
    budgetCents: number;
    inferenceMode?: InferenceMode;
    isCloudRun?: boolean;
    cloudRunCentsPerMin?: number;
  },
) {
  const runs = new InMemoryRunRepo();
  const workspace = new InMemoryWorkspace();
  const workspaceId = await workspace.createWorkspace("run-1");
  const run: AutoRun = {
    id: "run-1",
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    status: "running",
    input: { prompt: "do it" },
    budgetCents: opts.budgetCents,
    spentCents: 0,
    spentInferenceCents: 0,
    spentComputeCents: 0,
    inferenceMode: opts.inferenceMode ?? "managed",
    ...(opts.isCloudRun !== undefined ? { isCloudRun: opts.isCloudRun } : {}),
    ...(opts.cloudRunCentsPerMin !== undefined
      ? { cloudRunCentsPerMin: opts.cloudRunCentsPerMin }
      : {}),
    model: "claude-sonnet-4-6",
    createdAt: "2026-06-18T00:00:00.000Z",
    auditLog: [],
    workspaceId,
  };
  runs.seed(run);
  return { runs, workspace, workspaceId, run };
}

const USAGE = { inputTokens: 100, outputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 };
/** Large usage so 1500 vs 2500 bps produce distinct cent amounts (> 1¢ floor). */
const BIG_USAGE = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 0, cachedWriteTokens: 0 };

describe("Auto billing: markup", () => {
  it("managed turns debit inference at the AUTO markup (2500), not 1500", async () => {
    const AUTO_BPS = 2500;
    const { runs, workspace, run } = await setup({ budgetCents: 100_000_000 });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([bigTextResponse("done")]);
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "managed", markupBps: AUTO_BPS, maxTokens: 1_000_000 },
    });

    expect(out.status).toBe("succeeded");
    // The settled inference debit equals computeDebitCents at 2500, and differs
    // from the gateway's 1500 — proving Auto uses its own rate.
    const expected2500 = computeDebitCents(BIG_USAGE, "claude-sonnet-4-6", 2500);
    const expected1500 = computeDebitCents(BIG_USAGE, "claude-sonnet-4-6", 1500);
    expect(expected2500).toBeGreaterThan(expected1500);
    const inferenceSettles = ledger.settles.filter((s) => !s.sourceRef?.endsWith(":compute"));
    expect(inferenceSettles).toHaveLength(1);
    expect(inferenceSettles[0]!.cents).toBe(expected2500);
    expect(out.spentInferenceCents).toBe(expected2500);
    expect(out.spentComputeCents).toBe(0);
  });
});

describe("Auto billing: BYO inference", () => {
  it("BYO mode skips the inference debit entirely (ledger inference-untouched)", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 1_000_000, inferenceMode: "byo" });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([textResponse("done")]);
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "byo", markupBps: 2500, maxTokens: 100 },
    });

    expect(out.status).toBe("succeeded");
    expect(provider.calls).toBe(1); // the BYO provider WAS called
    expect(ledger.reserves).toHaveLength(0); // no hold for inference
    expect(ledger.settles).toHaveLength(0);
    expect(out.spentInferenceCents).toBe(0);
    expect(out.spentComputeCents).toBe(0);
  });
});

describe("Auto billing: per-minute cloud-run fee", () => {
  it("cloud + BYO debits the per-minute fee (hold reserved, settled on completion)", async () => {
    const RATE = 5; // cents/min
    const { runs, workspace, run } = await setup({
      budgetCents: 100, // estimatedMin = floor(100/5) = 20
      inferenceMode: "byo",
      isCloudRun: true,
      cloudRunCentsPerMin: RATE,
    });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    // Advance the clock ~3.5 minutes of wall-clock during the model call.
    const slowProvider = new FakeChatProvider([textResponse("done")]);
    const origSend = slowProvider.sendMessage.bind(slowProvider);
    slowProvider.sendMessage = async (req) => {
      clock.advanceMinutes(3.5);
      return origSend(req);
    };

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: slowProvider, ledger, runs, workspace, now: clock.now, inferenceMode: "byo", cloudRunCentsPerMin: RATE, maxTokens: 100 },
    });

    expect(out.status).toBe("succeeded");
    // Up-front hold = estimatedMin (20) * rate (5) = 100.
    expect(ledger.reserves).toHaveLength(1);
    expect(ledger.reserves[0]!.cents).toBe(100);
    // Settled compute = ceil(3.5) * 5 = 20.
    const computeSettles = ledger.settles.filter((s) => s.sourceRef?.endsWith(":compute"));
    expect(computeSettles).toHaveLength(1);
    expect(computeSettles[0]!.cents).toBe(20);
    expect(out.spentComputeCents).toBe(20);
    expect(out.spentInferenceCents).toBe(0); // BYO → no inference debit
    expect(out.spentCents).toBe(20);
    // The run record persisted the compute total too.
    expect((await runs.getRun("run-1"))?.spentComputeCents).toBe(20);
  });

  it("settles the compute hold on FAILURE (provider throws)", async () => {
    const RATE = 5;
    const { runs, workspace, run } = await setup({
      budgetCents: 100,
      inferenceMode: "byo",
      isCloudRun: true,
      cloudRunCentsPerMin: RATE,
    });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const provider = new FakeChatProvider([]); // empty → throws
    const origSend = provider.sendMessage.bind(provider);
    provider.sendMessage = async (req) => {
      clock.advanceMinutes(1.2); // 1.2 min before the throw → ceil = 2
      return origSend(req);
    };
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "byo", cloudRunCentsPerMin: RATE, maxTokens: 100 },
    });

    expect(out.status).toBe("failed");
    const computeSettles = ledger.settles.filter((s) => s.sourceRef?.endsWith(":compute"));
    expect(computeSettles).toHaveLength(1);
    expect(computeSettles[0]!.cents).toBe(Math.ceil(1.2) * RATE); // 2 * 5 = 10
    expect(out.spentComputeCents).toBe(10);
  });

  it("settles the compute hold on CANCEL (kill-switch)", async () => {
    const RATE = 5;
    const { runs, workspace, run } = await setup({
      budgetCents: 100,
      inferenceMode: "byo",
      isCloudRun: true,
      cloudRunCentsPerMin: RATE,
    });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "a.txt", content: "x" }),
      textResponse("unreached"),
    ]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, resolvedTools: ["write_file"], now: clock.now });
    // Cancel during the first tool round; advance the clock 0.4 min.
    const exec2 = async (tu: Parameters<typeof exec>[0]) => {
      clock.advanceMinutes(0.4);
      await runs.requestCancel("run-1");
      return exec(tu);
    };

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [{ name: "write_file", description: "", inputSchema: {} }],
      executeTool: exec2,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "byo", cloudRunCentsPerMin: RATE, maxTokens: 100 },
    });

    expect(out.status).toBe("canceled");
    const computeSettles = ledger.settles.filter((s) => s.sourceRef?.endsWith(":compute"));
    expect(computeSettles).toHaveLength(1);
    expect(computeSettles[0]!.cents).toBe(Math.ceil(0.4) * RATE); // 1 * 5 = 5
  });

  it("rejects (throws → failed) when the up-front compute hold can't be reserved", async () => {
    const { runs, workspace, run } = await setup({
      budgetCents: 100,
      inferenceMode: "byo",
      isCloudRun: true,
      cloudRunCentsPerMin: 5,
    });
    const ledger = new TrackingLedger();
    ledger.rejectReserve = true;
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("unreached")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "byo", cloudRunCentsPerMin: 5, maxTokens: 100 },
    });

    expect(out.status).toBe("failed");
    expect(provider.calls).toBe(0); // never reached the provider
    expect(out.spentComputeCents).toBe(0);
  });

  it("local + BYO = zero compute debit", async () => {
    const { runs, workspace, run } = await setup({
      budgetCents: 100,
      inferenceMode: "byo",
      isCloudRun: false, // LOCAL
      cloudRunCentsPerMin: 5,
    });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("done")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "byo", cloudRunCentsPerMin: 5, maxTokens: 100 },
    });

    expect(out.status).toBe("succeeded");
    expect(ledger.reserves).toHaveLength(0);
    expect(ledger.settles).toHaveLength(0);
    expect(out.spentComputeCents).toBe(0);
  });

  it("managed cloud = zero SEPARATE compute debit (only the inference markup)", async () => {
    const { runs, workspace, run } = await setup({
      budgetCents: 1_000_000,
      inferenceMode: "managed",
      isCloudRun: true, // CLOUD but MANAGED → compute bundled into the 25%
      cloudRunCentsPerMin: 5,
    });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("done")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "managed", markupBps: 2500, cloudRunCentsPerMin: 5, maxTokens: 100 },
    });

    expect(out.status).toBe("succeeded");
    // No compute hold/settle — only the inference settle.
    const computeSettles = ledger.settles.filter((s) => s.sourceRef?.endsWith(":compute"));
    expect(computeSettles).toHaveLength(0);
    expect(out.spentComputeCents).toBe(0);
    expect(out.spentInferenceCents).toBe(computeDebitCents(USAGE, "claude-sonnet-4-6", 2500));
  });
});
