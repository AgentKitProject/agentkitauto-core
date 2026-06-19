/**
 * Scheduler orchestrator tests (Phase B): due selection, per-schedule isolation,
 * disabled-skip, approval-invalid → lastError + nextRunAt still advanced (no
 * hot-loop), nextRunAt persisted, and no double-fire within a minute. Uses the
 * in-memory repo fakes + a fake createAndDispatch.
 */

import { describe, expect, it } from "vitest";
import { runDueSchedules, type CreateAndDispatch } from "../src/core/schedule-runner.js";
import type { AutoRun, AutoSchedule, KitRef } from "../src/core/types.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { InMemoryScheduleRepo } from "./schedule-repo-fake.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const NOW = "2026-06-18T00:00:00.000Z";

function makeSchedule(over: Partial<AutoSchedule> = {}): AutoSchedule {
  return {
    id: "sched-1",
    userId: "u1",
    kitRef: KIT,
    cron: "*/5 * * * *",
    timezone: "UTC",
    input: { prompt: "task" },
    budgetCents: 200,
    model: "claude-sonnet-4-6",
    approvalId: "appr-1",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastRunAt: null,
    lastRunId: null,
    // Due at/at-or-before NOW.
    nextRunAt: "2026-06-17T23:55:00.000Z",
    lastError: null,
    ...over,
  };
}

/** A createAndDispatch that returns a fake run and records calls. */
function fakeDispatcher(): { fn: CreateAndDispatch; calls: AutoSchedule[] } {
  const calls: AutoSchedule[] = [];
  let seq = 0;
  const fn: CreateAndDispatch = async (schedule) => {
    calls.push(schedule);
    const run: AutoRun = {
      id: `run-${++seq}`,
      userId: schedule.userId,
      kitRef: schedule.kitRef,
      status: "queued",
      input: schedule.input,
      budgetCents: schedule.budgetCents,
      spentCents: 0,
      model: schedule.model,
      createdAt: NOW,
      auditLog: [],
      trigger: "schedule",
      scheduleId: schedule.id,
    };
    return run;
  };
  return { fn, calls };
}

async function setup() {
  const schedules = new InMemoryScheduleRepo();
  const approvals = new InMemoryApprovalRepo();
  // A valid standing approval matching the kit + budget ceiling.
  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: ["read_file"],
    maxBudgetCents: 1000,
    createdAt: NOW,
  });
  return { schedules, approvals };
}

describe("runDueSchedules", () => {
  it("dispatches a due, enabled schedule and advances nextRunAt", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule());
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });

    expect(summary).toMatchObject({ processed: 1, dispatched: 1, skipped: 0, errors: [] });
    expect(dispatcher.calls.length).toBe(1);
    const after = await schedules.getSchedule("sched-1");
    expect(after?.lastRunId).toBe("run-1");
    expect(after?.lastError).toBeNull();
    // Next fire computed from NOW for '*/5' = 00:05.
    expect(after?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
  });

  it("skips a disabled schedule (and never selects it)", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule({ enabled: false }));
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });
    // listDueSchedules filters out disabled → not even processed.
    expect(summary).toMatchObject({ processed: 0, dispatched: 0 });
    expect(dispatcher.calls.length).toBe(0);
  });

  it("records lastError + advances nextRunAt when no approval exists (no hot-loop)", async () => {
    const schedules = new InMemoryScheduleRepo();
    const approvals = new InMemoryApprovalRepo(); // empty — no approval
    schedules.seed(makeSchedule());
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });

    expect(summary).toMatchObject({ processed: 1, dispatched: 0, skipped: 1 });
    expect(dispatcher.calls.length).toBe(0);
    const after = await schedules.getSchedule("sched-1");
    expect(after?.lastError).toMatch(/No standing approval/);
    // Crucially: nextRunAt advanced past NOW so it leaves the due set.
    expect(after?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
    expect((await schedules.listDueSchedules("2026-06-18T00:01:00.000Z")).length).toBe(0);
  });

  it("skips + advances when the budget exceeds the approval ceiling", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule({ budgetCents: 5000 })); // > 1000 ceiling
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });
    expect(summary).toMatchObject({ skipped: 1, dispatched: 0 });
    const after = await schedules.getSchedule("sched-1");
    expect(after?.lastError).toMatch(/exceeds the approval ceiling/);
    expect(after?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
  });

  it("skips + advances when the approval is revoked", async () => {
    const { schedules, approvals } = await setup();
    const list = await approvals.listApprovalsByUser("u1");
    await approvals.revokeApproval(list[0]!.id, NOW);
    schedules.seed(makeSchedule());
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });
    expect(summary).toMatchObject({ skipped: 1, dispatched: 0 });
    // getApprovalForKit returns only non-revoked rows, so a revoked approval is
    // indistinguishable from "no approval" at the gate — either way: skipped,
    // lastError recorded, nextRunAt advanced (no hot-loop).
    const after = await schedules.getSchedule("sched-1");
    expect(after?.lastError).toMatch(/No standing approval|revoked/);
    expect(after?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
  });

  it("isolates a throwing schedule — others still dispatch", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule({ id: "ok-a" }));
    schedules.seed(makeSchedule({ id: "boom" }));
    schedules.seed(makeSchedule({ id: "ok-b" }));

    const calls: string[] = [];
    const createAndDispatch: CreateAndDispatch = async (s) => {
      if (s.id === "boom") throw new Error("dispatch blew up");
      calls.push(s.id);
      return {
        id: `run-${s.id}`,
        userId: s.userId,
        kitRef: s.kitRef,
        status: "queued",
        input: s.input,
        budgetCents: s.budgetCents,
        spentCents: 0,
        model: s.model,
        createdAt: NOW,
        auditLog: [],
        trigger: "schedule",
        scheduleId: s.id,
      } satisfies AutoRun;
    };

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch,
    });

    expect(summary.processed).toBe(3);
    expect(summary.dispatched).toBe(2);
    expect(summary.errors).toEqual([{ scheduleId: "boom", error: "dispatch blew up" }]);
    expect(calls.sort()).toEqual(["ok-a", "ok-b"]);
    // The thrown schedule still advanced nextRunAt (no hot-loop) + recorded error.
    const boom = await schedules.getSchedule("boom");
    expect(boom?.lastError).toBe("dispatch blew up");
    expect(boom?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
  });

  it("does not double-fire within the same minute (re-entrant sweep)", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule());
    const dispatcher = fakeDispatcher();

    // First sweep fires; nextRunAt advances to 00:05.
    await runDueSchedules({ deps: { schedules, approvals }, now: NOW, createAndDispatch: dispatcher.fn });
    // A re-entrant sweep at a slightly later instant in the SAME minute selects
    // nothing (nextRunAt 00:05 > now), so no second dispatch.
    const summary2 = await runDueSchedules({
      deps: { schedules, approvals },
      now: "2026-06-18T00:00:30.000Z",
      createAndDispatch: dispatcher.fn,
    });

    expect(dispatcher.calls.length).toBe(1);
    expect(summary2).toMatchObject({ processed: 0, dispatched: 0 });
  });

  it("processes multiple due schedules in one sweep", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule({ id: "s1" }));
    schedules.seed(makeSchedule({ id: "s2" }));
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });
    expect(summary).toMatchObject({ processed: 2, dispatched: 2 });
  });

  it("returns an empty summary when nothing is due", async () => {
    const { schedules, approvals } = await setup();
    schedules.seed(makeSchedule({ nextRunAt: "2099-01-01T00:00:00.000Z" }));
    const dispatcher = fakeDispatcher();

    const summary = await runDueSchedules({
      deps: { schedules, approvals },
      now: NOW,
      createAndDispatch: dispatcher.fn,
    });
    expect(summary).toMatchObject({ processed: 0, dispatched: 0, skipped: 0, errors: [] });
  });
});
