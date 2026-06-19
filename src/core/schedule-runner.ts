/**
 * The scheduling orchestrator (Phase B).
 *
 * `runDueSchedules` is the function a cron tick (EventBridge → Lambda, k8s
 * CronJob, or an in-process timer) invokes once per minute. It selects the
 * schedules due to fire, re-checks each one through the SAME Phase A approval
 * gate, and dispatches a run via an INJECTED `createAndDispatch` callback so
 * this package never hard-depends on the web-forge run-create + Fargate-dispatch
 * path (core stays runtime-agnostic).
 *
 * RESILIENCE: each schedule is processed in its own try/catch — one failing
 * schedule never aborts the sweep. Results are accumulated into a summary.
 *
 * DOUBLE-FIRE PREVENTION (the robust option): for every due schedule we compute
 * the NEXT fire time from `now` and PERSIST it via setScheduleRunResult BEFORE
 * returning from the schedule's processing. Because listDueSchedules selects on
 * `nextRunAt <= now`, advancing nextRunAt past `now` immediately removes the
 * schedule from the due set, so a re-entrant sweep within the same minute (or a
 * retried/overlapping tick) cannot select it again. We advance nextRunAt even
 * when the fire is SKIPPED (disabled/approval-invalid/over-budget) — otherwise a
 * permanently-invalid schedule would stay due forever and hot-loop every tick.
 */

import type { AutoApprovalRepository, AutoScheduleRepository } from "./ports.js";
import type { AutoRun, AutoSchedule } from "./types.js";
import { nextFireAfter } from "./cron.js";

/** Dependencies for a scheduling sweep. */
export interface RunDueSchedulesDeps {
  schedules: AutoScheduleRepository;
  approvals: AutoApprovalRepository;
}

/**
 * Injected run-create + dispatch. Given a due schedule, it must create the
 * AutoRun (trigger: "schedule", scheduleId set) and dispatch it onto the same
 * execution path on-demand runs use, then return the created run. Throwing is
 * caught per-schedule and recorded as lastError.
 */
export type CreateAndDispatch = (schedule: AutoSchedule) => Promise<AutoRun>;

export interface RunDueSchedulesArgs {
  deps: RunDueSchedulesDeps;
  /** Clock — ISO 8601. Threaded everywhere; never argless Date. */
  now: string;
  /** Creates + dispatches the run for a due schedule (see CreateAndDispatch). */
  createAndDispatch: CreateAndDispatch;
}

export interface ScheduleSweepError {
  scheduleId: string;
  error: string;
}

/** Summary of one sweep. */
export interface ScheduleSweepSummary {
  /** Due schedules examined. */
  processed: number;
  /** Schedules that dispatched a run. */
  dispatched: number;
  /** Due schedules skipped (disabled / approval invalid / over budget). */
  skipped: number;
  /** Per-schedule failures (dispatch threw); each is isolated. */
  errors: ScheduleSweepError[];
}

/**
 * Re-checks a due schedule against the standing approval (the Phase A gate),
 * mirroring processAutoRun's gate semantics:
 *   - a non-revoked approval for (userId, kitRef) must exist;
 *   - budgetCents <= approval.maxBudgetCents.
 * Returns a skip reason string, or null when the schedule may fire.
 */
async function approvalGateSkipReason(
  schedule: AutoSchedule,
  approvals: AutoApprovalRepository,
): Promise<string | null> {
  const approval = await approvals.getApprovalForKit(schedule.userId, schedule.kitRef);
  if (!approval) return "No standing approval exists for this kit.";
  if (approval.revokedAt !== null) {
    return "The standing approval for this kit has been revoked.";
  }
  if (schedule.budgetCents > approval.maxBudgetCents) {
    return `Schedule budget (${schedule.budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`;
  }
  return null;
}

/**
 * Process every due schedule for this tick. See the module comment for the
 * double-fire and resilience guarantees.
 */
export async function runDueSchedules(
  args: RunDueSchedulesArgs,
): Promise<ScheduleSweepSummary> {
  const { deps, now, createAndDispatch } = args;
  const { schedules, approvals } = deps;

  const summary: ScheduleSweepSummary = {
    processed: 0,
    dispatched: 0,
    skipped: 0,
    errors: [],
  };

  const due = await schedules.listDueSchedules(now);

  for (const schedule of due) {
    summary.processed += 1;

    // Compute the next fire up-front so we can ALWAYS advance nextRunAt, even on
    // skip/error — this is what prevents hot-looping and double-firing. If the
    // cron is somehow unparseable now (it was valid at create time), fall back
    // to nudging one minute past `now` so the row leaves the due set.
    let nextRunAt: string;
    try {
      nextRunAt = nextFireAfter(schedule.cron, now, schedule.timezone);
    } catch {
      nextRunAt = new Date(Date.parse(now) + 60_000).toISOString();
    }

    try {
      // Re-check enabled (it may have been disabled since selection) + the
      // approval gate. A skip still advances nextRunAt.
      if (!schedule.enabled) {
        summary.skipped += 1;
        await schedules.setScheduleRunResult(schedule.id, {
          lastRunAt: now,
          lastRunId: null,
          nextRunAt,
          lastError: "Schedule is disabled.",
        });
        continue;
      }

      const skipReason = await approvalGateSkipReason(schedule, approvals);
      if (skipReason !== null) {
        summary.skipped += 1;
        await schedules.setScheduleRunResult(schedule.id, {
          lastRunAt: now,
          lastRunId: null,
          nextRunAt,
          lastError: skipReason,
        });
        continue;
      }

      // Fire: create + dispatch the run via the injected callback.
      const run = await createAndDispatch(schedule);
      summary.dispatched += 1;
      await schedules.setScheduleRunResult(schedule.id, {
        lastRunAt: now,
        lastRunId: run.id,
        nextRunAt,
        lastError: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push({ scheduleId: schedule.id, error: message });
      // Still advance nextRunAt so a persistently-failing schedule does not
      // re-fire every tick. Best-effort — a persistence hiccup here is swallowed
      // so it can't abort the rest of the sweep.
      await schedules
        .setScheduleRunResult(schedule.id, {
          lastRunAt: now,
          lastRunId: null,
          nextRunAt,
          lastError: message,
        })
        .catch(() => {});
    }
  }

  return summary;
}
