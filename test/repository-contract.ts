/**
 * Backend-parametric repository contract for the Auto core. Run against BOTH the
 * Postgres self-host adapter (pg-mem) and the AWS DynamoDB adapter
 * (dynamodb-local, gated) to prove parity — mirrors gateway-core / market-core.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
} from "../src/core/ports.js";
import type {
  CreateRunInput,
  CreateApprovalInput,
  CreateScheduleInput,
} from "../src/core/types.js";

export interface ContractRepos {
  runs: AutoRunRepository;
  approvals: AutoApprovalRepository;
  schedules: AutoScheduleRepository;
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

function scheduleInput(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    cron: "*/5 * * * *",
    timezone: "UTC",
    input: { prompt: "do it", files: [{ path: "in.txt", content: "x" }] },
    budgetCents: 200,
    model: "claude-sonnet-4-6",
    approvalId: "appr-1",
    createdAt: NOW,
    nextRunAt: "2026-06-18T00:05:00.000Z",
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

    // ---- Runs: Phase B trigger/scheduleId back-compat -------------------
    it("defaults trigger to on_demand and round-trips schedule runs", async () => {
      const onDemand = await repos.runs.createRun(runInput());
      expect((await repos.runs.getRun(onDemand.id))?.trigger).toBe("on_demand");

      const scheduled = await repos.runs.createRun(
        runInput({ trigger: "schedule", scheduleId: "sched-1" }),
      );
      const fetched = await repos.runs.getRun(scheduled.id);
      expect(fetched?.trigger).toBe("schedule");
      expect(fetched?.scheduleId).toBe("sched-1");
    });

    // ---- Schedules (Phase B) --------------------------------------------
    it("creates + reads a schedule (round-trips kitRef + input + cron)", async () => {
      const created = await repos.schedules.createSchedule(scheduleInput());
      expect(created.enabled).toBe(true);
      expect(created.lastRunAt).toBeNull();
      const fetched = await repos.schedules.getSchedule(created.id);
      expect(fetched?.cron).toBe("*/5 * * * *");
      expect(fetched?.timezone).toBe("UTC");
      expect(fetched?.kitRef).toEqual({ source: "local", localKitId: "k1" });
      expect(fetched?.input.prompt).toBe("do it");
      expect(fetched?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
    });

    it("lists schedules by user", async () => {
      await repos.schedules.createSchedule(scheduleInput());
      await repos.schedules.createSchedule(scheduleInput());
      await repos.schedules.createSchedule(scheduleInput({ userId: "other" }));
      expect((await repos.schedules.listSchedulesByUser("u1")).length).toBe(2);
      expect((await repos.schedules.listSchedulesByUser("other")).length).toBe(1);
    });

    it("selects only enabled + due schedules", async () => {
      const due = await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      // Not yet due.
      await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2099-01-01T00:00:00.000Z" }),
      );
      // Due but disabled.
      await repos.schedules.createSchedule(
        scheduleInput({ enabled: false, nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      const dueList = await repos.schedules.listDueSchedules("2026-06-18T00:01:00.000Z");
      expect(dueList.map((s) => s.id)).toEqual([due.id]);
    });

    it("disabling a schedule removes it from the due set", async () => {
      const created = await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      expect((await repos.schedules.listDueSchedules(NOW)).length).toBe(1);
      const updated = await repos.schedules.updateSchedule(created.id, {
        enabled: false,
        updatedAt: NOW,
      });
      expect(updated?.enabled).toBe(false);
      expect((await repos.schedules.listDueSchedules(NOW)).length).toBe(0);
    });

    it("records a fire result (advances nextRunAt; stamps lastRunId/lastError)", async () => {
      const created = await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      await repos.schedules.setScheduleRunResult(created.id, {
        lastRunAt: NOW,
        lastRunId: "run-xyz",
        nextRunAt: "2026-06-18T00:05:00.000Z",
        lastError: null,
      });
      const fetched = await repos.schedules.getSchedule(created.id);
      expect(fetched?.lastRunId).toBe("run-xyz");
      expect(fetched?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
      expect(fetched?.lastError).toBeNull();
      // Advanced past now → no longer due.
      expect((await repos.schedules.listDueSchedules("2026-06-18T00:01:00.000Z")).length).toBe(0);
    });

    it("deletes a schedule", async () => {
      const created = await repos.schedules.createSchedule(scheduleInput());
      await repos.schedules.deleteSchedule(created.id);
      expect(await repos.schedules.getSchedule(created.id)).toBeUndefined();
    });
  });
}
