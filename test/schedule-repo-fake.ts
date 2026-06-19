/** In-memory AutoScheduleRepository for scheduler + worker/gate tests. */

import { randomUUID } from "node:crypto";
import type { AutoScheduleRepository, ScheduleRunResult } from "../src/core/ports.js";
import type {
  AutoSchedule,
  CreateScheduleInput,
  UpdateScheduleInput,
} from "../src/core/types.js";

export class InMemoryScheduleRepo implements AutoScheduleRepository {
  schedules = new Map<string, AutoSchedule>();

  seed(schedule: AutoSchedule): AutoSchedule {
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async createSchedule(input: CreateScheduleInput): Promise<AutoSchedule> {
    const schedule: AutoSchedule = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      input: input.input,
      budgetCents: input.budgetCents,
      model: input.model,
      approvalId: input.approvalId,
      ...(input.inferenceMode !== undefined ? { inferenceMode: input.inferenceMode } : {}),
      enabled: input.enabled ?? true,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      lastRunAt: null,
      lastRunId: null,
      nextRunAt: input.nextRunAt,
      lastError: null,
    };
    this.schedules.set(schedule.id, schedule);
    return structuredClone(schedule);
  }

  async getSchedule(scheduleId: string): Promise<AutoSchedule | undefined> {
    const s = this.schedules.get(scheduleId);
    return s ? structuredClone(s) : undefined;
  }

  async listSchedulesByUser(userId: string): Promise<AutoSchedule[]> {
    return [...this.schedules.values()]
      .filter((s) => s.userId === userId)
      .map((s) => structuredClone(s));
  }

  async listDueSchedules(nowISO: string): Promise<AutoSchedule[]> {
    return [...this.schedules.values()]
      .filter((s) => s.enabled && s.nextRunAt <= nowISO)
      .map((s) => structuredClone(s));
  }

  async updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined> {
    const s = this.schedules.get(scheduleId);
    if (!s) return undefined;
    if (patch.cron !== undefined) s.cron = patch.cron;
    if (patch.timezone !== undefined) s.timezone = patch.timezone;
    if (patch.input !== undefined) s.input = patch.input;
    if (patch.budgetCents !== undefined) s.budgetCents = patch.budgetCents;
    if (patch.model !== undefined) s.model = patch.model;
    if (patch.approvalId !== undefined) s.approvalId = patch.approvalId;
    if (patch.inferenceMode !== undefined) s.inferenceMode = patch.inferenceMode;
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
    if (patch.nextRunAt !== undefined) s.nextRunAt = patch.nextRunAt;
    s.updatedAt = patch.updatedAt;
    return structuredClone(s);
  }

  async setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void> {
    const s = this.schedules.get(scheduleId);
    if (!s) return;
    s.lastRunAt = result.lastRunAt;
    s.lastRunId = result.lastRunId;
    s.nextRunAt = result.nextRunAt;
    s.lastError = result.lastError;
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    this.schedules.delete(scheduleId);
  }
}
