/**
 * Run driver: autonomous loop + budget cap + kill-switch.
 *
 * Uses a FAKE ChatProvider + the gateway-core InMemory-equivalent ledger (built
 * inline) so tests are deterministic and offline — no real model is called.
 *
 * Asserts:
 *   - normal completion sets result + status succeeded;
 *   - a tool_use turn drives the sandbox executor then completes;
 *   - budget cap stops the loop with status budget_exceeded;
 *   - the kill-switch stops the loop with status canceled;
 *   - a provider error → status failed.
 */

import { describe, expect, it } from "vitest";
import { runAutoRun } from "../src/core/run-driver.js";
import { makeSandboxExecutor } from "../src/core/sandbox-executor.js";
import type { AutoApproval, AutoRun } from "../src/core/types.js";
import type { CreditLedgerRepository } from "@agentkitforge/gateway-core";
import {
  FakeChatProvider,
  InMemoryRunRepo,
  InMemoryWorkspace,
  noopNow,
  textResponse,
  toolUseResponse,
} from "./fakes.js";

// Minimal ledger fake (two-phase hold; always-funded) — mirrors gateway-core's.
class FundedLedger implements CreditLedgerRepository {
  private held = new Map<string, number>();
  private seq = 0;
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
  async reserveHold(_userId: string, maxCostCents: number) {
    const id = `h-${++this.seq}`;
    this.held.set(id, maxCostCents);
    return id;
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

const approval: AutoApproval = {
  id: "appr-1",
  userId: "u1",
  kitRef: { source: "local", localKitId: "k1" },
  scope: "workspace_read_write",
  toolAllowlist: ["read_file", "list_dir", "write_file"],
  networkPolicy: { mode: "deny_all" },
  maxBudgetCents: 100_000,
  createdAt: noopNow(),
  revokedAt: null,
};

async function setup(budgetCents: number) {
  const runs = new InMemoryRunRepo();
  const workspace = new InMemoryWorkspace();
  const workspaceId = await workspace.createWorkspace("run-1");
  const run: AutoRun = {
    id: "run-1",
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    status: "running",
    input: { prompt: "do the task" },
    budgetCents,
    spentCents: 0,
    model: "claude-sonnet-4-6",
    createdAt: noopNow(),
    auditLog: [],
    workspaceId,
  };
  runs.seed(run);
  return { runs, workspace, workspaceId, run };
}

function driverDeps(runs: InMemoryRunRepo, workspace: InMemoryWorkspace, provider: FakeChatProvider) {
  return {
    chatProvider: provider,
    ledger: new FundedLedger(),
    runs,
    workspace,
    now: noopNow,
    maxTokens: 1024,
  };
}

describe("runAutoRun", () => {
  it("completes normally and sets result + succeeded", async () => {
    const { runs, workspace, workspaceId, run } = await setup(100_000);
    const provider = new FakeChatProvider([textResponse("all done")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId, runId: run.id, approval, repo: runs, now: noopNow });
    const out = await runAutoRun({
      run,
      approval,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: driverDeps(runs, workspace, provider),
    });
    expect(out.status).toBe("succeeded");
    expect(out.result?.output).toBe("all done");
    const persisted = await runs.getRun("run-1");
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.result?.output).toBe("all done");
  });

  it("drives a tool_use round then completes", async () => {
    const { runs, workspace, workspaceId, run } = await setup(100_000);
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "note.txt", content: "hello" }),
      textResponse("wrote the file"),
    ]);
    const exec = makeSandboxExecutor({
      workspace,
      workspaceId,
      runId: run.id,
      approval,
      repo: runs,
      resolvedTools: ["write_file"],
      now: noopNow,
    });
    const out = await runAutoRun({
      run,
      approval,
      systemPrompt: "sys",
      tools: [{ name: "write_file", description: "", inputSchema: {} }],
      executeTool: exec,
      deps: driverDeps(runs, workspace, provider),
    });
    expect(out.status).toBe("succeeded");
    expect(out.toolRounds).toBe(1);
    expect(await workspace.readFile(workspaceId, "note.txt")).toBe("hello");
    const persisted = await runs.getRun("run-1");
    expect(persisted?.auditLog.at(-1)?.tool).toBe("write_file");
    expect(persisted?.result?.files.some((f) => f.path === "note.txt")).toBe(true);
  });

  it("stops with budget_exceeded once spend reaches the budget", async () => {
    // Budget is tiny; the first turn's debit (>=1¢) pushes spent >= budget.
    const { runs, workspace, workspaceId, run } = await setup(1);
    // First response is a tool_use so the loop WOULD continue, but budget caps it.
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "a.txt", content: "x" }),
      textResponse("should never reach"),
    ]);
    const exec = makeSandboxExecutor({
      workspace,
      workspaceId,
      runId: run.id,
      approval,
      repo: runs,
      resolvedTools: ["write_file"],
      now: noopNow,
    });
    const out = await runAutoRun({
      run,
      approval,
      systemPrompt: "sys",
      tools: [{ name: "write_file", description: "", inputSchema: {} }],
      executeTool: exec,
      deps: driverDeps(runs, workspace, provider),
    });
    expect(out.status).toBe("budget_exceeded");
    // Only one provider call happened (the loop stopped before the 2nd turn).
    expect(provider.calls).toBe(1);
    expect((await runs.getRun("run-1"))?.status).toBe("budget_exceeded");
  });

  it("stops with canceled when the kill-switch is set mid-flight", async () => {
    const { runs, workspace, workspaceId, run } = await setup(100_000);
    // First turn is a tool_use; we request cancel during tool execution.
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "a.txt", content: "x" }),
      textResponse("should never reach"),
    ]);
    const exec = makeSandboxExecutor({
      workspace,
      workspaceId,
      runId: run.id,
      approval,
      repo: runs,
      resolvedTools: ["write_file"],
      now: noopNow,
    });
    // Wrap exec to flip the kill-switch the first time a tool runs.
    const exec2 = async (tu: Parameters<typeof exec>[0]) => {
      await runs.requestCancel("run-1");
      return exec(tu);
    };
    const out = await runAutoRun({
      run,
      approval,
      systemPrompt: "sys",
      tools: [{ name: "write_file", description: "", inputSchema: {} }],
      executeTool: exec2,
      deps: driverDeps(runs, workspace, provider),
    });
    expect(out.status).toBe("canceled");
    expect(provider.calls).toBe(1);
  });

  it("fails when the provider throws", async () => {
    const { runs, workspace, workspaceId, run } = await setup(100_000);
    const provider = new FakeChatProvider([]); // empty queue → throws
    const exec = makeSandboxExecutor({ workspace, workspaceId, runId: run.id, approval, repo: runs, now: noopNow });
    const out = await runAutoRun({
      run,
      approval,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: driverDeps(runs, workspace, provider),
    });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/no more scripted responses/i);
    expect((await runs.getRun("run-1"))?.status).toBe("failed");
  });
});
