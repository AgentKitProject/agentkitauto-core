/**
 * Backend-parametric repository contract for the Auto core. Run against BOTH the
 * Postgres self-host adapter (pg-mem) and the AWS DynamoDB adapter
 * (dynamodb-local, gated) to prove parity — mirrors gateway-core / market-core.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AutoApprovalRepository, AutoRunRepository } from "../src/core/ports.js";
import type { CreateRunInput, CreateApprovalInput } from "../src/core/types.js";

export interface ContractRepos {
  runs: AutoRunRepository;
  approvals: AutoApprovalRepository;
  reset: () => Promise<void>;
}

const NOW = "2026-06-18T00:00:00.000Z";

function runInput(over: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    input: { prompt: "task", files: [{ path: "in.txt", content: "x" }] },
    budgetCents: 500,
    model: "claude-sonnet-4-6",
    createdAt: NOW,
    ...over,
  };
}

function approvalInput(over: Partial<CreateApprovalInput> = {}): CreateApprovalInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    toolAllowlist: ["read_file", "write_file"],
    maxBudgetCents: 1000,
    createdAt: NOW,
    ...over,
  };
}

export function runRepositoryContract(label: string, makeRepos: () => Promise<ContractRepos>): void {
  describe(`Auto repository contract [${label}]`, () => {
    let repos: ContractRepos;
    beforeEach(async () => {
      repos = await makeRepos();
      await repos.reset();
    });

    it("creates and reads a run (round-trips kitRef + input JSON)", async () => {
      const created = await repos.runs.createRun(runInput());
      expect(created.status).toBe("queued");
      expect(created.spentCents).toBe(0);
      const fetched = await repos.runs.getRun(created.id);
      expect(fetched?.kitRef).toEqual({ source: "local", localKitId: "k1" });
      expect(fetched?.input.files?.[0]?.path).toBe("in.txt");
      expect(fetched?.budgetCents).toBe(500);
    });

    it("records spend additively", async () => {
      const run = await repos.runs.createRun(runInput());
      expect(await repos.runs.recordSpend(run.id, 10)).toBe(10);
      expect(await repos.runs.recordSpend(run.id, 5)).toBe(15);
      expect((await repos.runs.getRun(run.id))?.spentCents).toBe(15);
    });

    it("appends audit entries in order (append-only)", async () => {
      const run = await repos.runs.createRun(runInput());
      await repos.runs.appendAudit(run.id, { tool: "read_file", argsSummary: "path=a", outcome: "ok", ts: NOW });
      await repos.runs.appendAudit(run.id, { tool: "write_file", argsSummary: "path=b", outcome: "rejected", ts: NOW });
      const log = (await repos.runs.getRun(run.id))?.auditLog ?? [];
      expect(log.map((e) => e.tool)).toEqual(["read_file", "write_file"]);
      expect(log[1]?.outcome).toBe("rejected");
    });

    it("updates status + stamps fields and sets a result", async () => {
      const run = await repos.runs.createRun(runInput());
      await repos.runs.updateRunStatus(run.id, "running", { startedAt: NOW, workspaceId: "ws-x" });
      await repos.runs.setResult(run.id, { output: "done", files: [{ path: "out.txt", sizeBytes: 4 }] });
      await repos.runs.updateRunStatus(run.id, "succeeded", { finishedAt: NOW });
      const fetched = await repos.runs.getRun(run.id);
      expect(fetched?.status).toBe("succeeded");
      expect(fetched?.workspaceId).toBe("ws-x");
      expect(fetched?.result?.output).toBe("done");
      expect(fetched?.result?.files[0]?.sizeBytes).toBe(4);
    });

    it("supports the kill-switch", async () => {
      const run = await repos.runs.createRun(runInput());
      expect(await repos.runs.isCancelRequested(run.id)).toBe(false);
      await repos.runs.requestCancel(run.id);
      expect(await repos.runs.isCancelRequested(run.id)).toBe(true);
    });

    it("lists runs by user", async () => {
      await repos.runs.createRun(runInput());
      await repos.runs.createRun(runInput());
      await repos.runs.createRun(runInput({ userId: "other" }));
      expect((await repos.runs.listRunsByUser("u1")).length).toBe(2);
    });

    it("creates an approval and finds it by kit (non-revoked only)", async () => {
      const created = await repos.approvals.createApproval(approvalInput());
      expect(created.networkPolicy).toBe("deny_all");
      expect(created.scope).toBe("workspace_read_write");
      const found = await repos.approvals.getApprovalForKit("u1", { source: "local", localKitId: "k1" });
      expect(found?.id).toBe(created.id);
      // Different kit → no match.
      expect(await repos.approvals.getApprovalForKit("u1", { source: "local", localKitId: "other" })).toBeUndefined();
    });

    it("revokes an approval so it no longer matches", async () => {
      const created = await repos.approvals.createApproval(approvalInput());
      await repos.approvals.revokeApproval(created.id, NOW);
      expect(
        await repos.approvals.getApprovalForKit("u1", { source: "local", localKitId: "k1" }),
      ).toBeUndefined();
      // Still listed (for history), but revoked.
      const listed = await repos.approvals.listApprovalsByUser("u1");
      expect(listed.find((a) => a.id === created.id)?.revokedAt).toBe(NOW);
    });
  });
}
