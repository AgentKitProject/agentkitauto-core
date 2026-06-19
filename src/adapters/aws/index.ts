/**
 * AWS adapter for the Auto core.
 *
 * Implements:
 *   - AutoRunRepository       over DynamoDB (table `AutoRuns`, PK runId; audit
 *                             appended via list_append, spend via atomic ADD,
 *                             kill-switch via a boolean flag).
 *   - AutoApprovalRepository  over DynamoDB (table `AutoApprovals`, PK approvalId,
 *                             GSI userKitKey-index for getApprovalForKit, GSI
 *                             userId-index for listApprovalsByUser).
 *   - WorkspaceStore          via FsWorkspaceStore rooted at an OS tmp dir.
 *
 * WORKSPACE CHOICE (Phase A): workspaces are run-ephemeral and small, and the
 * Fargate/Job task that runs them is short-lived, so we back them with a local
 * tmp dir on the task's own filesystem (FsWorkspaceStore) rather than S3. An
 * S3-prefix-backed WorkspaceStore (durable, cross-task) is a Phase B/C concern
 * and slots in behind the same WorkspaceStore port without touching the driver.
 *
 * Explicit-creds env pattern mirrors gateway-core / forge-web: FORGE_AWS_* take
 * precedence, falling back to AWS_REGION / the default credential chain.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  ScheduleRunResult,
} from "../../core/ports.js";
import type {
  AuditEntry,
  AutoApproval,
  AutoRun,
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  CreateApprovalInput,
  CreateRunInput,
  CreateScheduleInput,
  KitRef,
  UpdateScheduleInput,
} from "../../core/types.js";
import { kitRefKey } from "../../core/types.js";
import { FsWorkspaceStore } from "../../core/fs-workspace.js";

// ---------------------------------------------------------------------------
// Client factory (FORGE_AWS_* explicit creds, like gateway-core / forge-web)
// ---------------------------------------------------------------------------

export function awsClientEnv(
  env: Record<string, string | undefined> = process.env,
): DynamoDBClientConfig {
  const region = env["FORGE_AWS_REGION"] || env["AWS_REGION"] || "us-east-1";
  const accessKeyId = env["FORGE_AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["FORGE_AWS_SECRET_ACCESS_KEY"];
  return {
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  };
}

export function createDynamoDBDocumentClient(
  config?: DynamoDBClientConfig,
): DynamoDBDocumentClient {
  const client = new DynamoDBClient(config ?? awsClientEnv());
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export interface AutoDynamoTableNames {
  runs: string;
  approvals: string;
  schedules: string;
}

export const AUTO_TABLE_ENV_VARS = {
  runs: "AUTO_RUNS_TABLE",
  approvals: "AUTO_APPROVALS_TABLE",
  schedules: "AUTO_SCHEDULES_TABLE",
} as const;

export function loadAutoDynamoTableNames(
  env: Record<string, string | undefined> = process.env,
): AutoDynamoTableNames {
  const resolve = (key: string): string => {
    const value = env[key];
    if (!value || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };
  return {
    runs: resolve(AUTO_TABLE_ENV_VARS.runs),
    approvals: resolve(AUTO_TABLE_ENV_VARS.approvals),
    schedules: resolve(AUTO_TABLE_ENV_VARS.schedules),
  };
}

// ---------------------------------------------------------------------------
// DynamoDB AutoRunRepository
// ---------------------------------------------------------------------------

export class DynamoAutoRunRepository implements AutoRunRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createRun(input: CreateRunInput): Promise<AutoRun> {
    const run: AutoRun = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      status: "queued",
      input: input.input,
      budgetCents: input.budgetCents,
      spentCents: 0,
      spentInferenceCents: 0,
      spentComputeCents: 0,
      inferenceMode: input.inferenceMode ?? "managed",
      ...(input.isCloudRun !== undefined ? { isCloudRun: input.isCloudRun } : {}),
      ...(input.cloudRunCentsPerMin !== undefined
        ? { cloudRunCentsPerMin: input.cloudRunCentsPerMin }
        : {}),
      model: input.model,
      createdAt: input.createdAt,
      auditLog: [],
      cancelRequested: false,
      trigger: input.trigger ?? "on_demand",
      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        // GSI partition for listRunsByUser.
        Item: { ...run, gsiUserId: input.userId },
      }),
    );
    return run;
  }

  async getRun(runId: string): Promise<AutoRun | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: runId } }),
    );
    return result.Item ? stripGsi(result.Item) : undefined;
  }

  async listRunsByUser(userId: string, limit = 50): Promise<AutoRun[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((i) => stripGsi(i));
  }

  async updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields: { startedAt?: string; finishedAt?: string; error?: string; workspaceId?: string } = {},
  ): Promise<AutoRun | undefined> {
    const sets: string[] = ["#s = :s"];
    const names: Record<string, string> = { "#s": "status" };
    const values: Record<string, unknown> = { ":s": status };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = :${k}`);
      values[`:${k}`] = v;
    }
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes ? stripGsi(result.Attributes) : undefined;
  }

  async appendAudit(runId: string, entry: AuditEntry): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression:
          "SET auditLog = list_append(if_not_exists(auditLog, :empty), :e)",
        ExpressionAttributeValues: { ":empty": [] as AuditEntry[], ":e": [entry] },
      }),
    );
  }

  async setResult(runId: string, result: AutoRunResult): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: "SET #r = :r",
        ExpressionAttributeNames: { "#r": "result" },
        ExpressionAttributeValues: { ":r": result },
      }),
    );
  }

  async recordSpend(runId: string, deltaCents: number): Promise<number> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: "ADD spentCents :d",
        ExpressionAttributeValues: { ":d": deltaCents },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (result.Attributes?.["spentCents"] as number) ?? deltaCents;
  }

  async requestCancel(runId: string): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: "SET cancelRequested = :t",
        ExpressionAttributeValues: { ":t": true },
      }),
    );
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    return run?.cancelRequested === true;
  }
}

function stripGsi(item: Record<string, unknown>): AutoRun {
  const { gsiUserId: _gsiUserId, ...rest } = item as Record<string, unknown> & {
    gsiUserId?: string;
  };
  return rest as unknown as AutoRun;
}

// ---------------------------------------------------------------------------
// DynamoDB AutoApprovalRepository
// ---------------------------------------------------------------------------

export class DynamoAutoApprovalRepository implements AutoApprovalRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createApproval(input: CreateApprovalInput): Promise<AutoApproval> {
    const approval: AutoApproval = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      scope: input.scope ?? "workspace_read_write",
      toolAllowlist: input.toolAllowlist,
      networkPolicy: input.networkPolicy ?? "deny_all",
      maxBudgetCents: input.maxBudgetCents,
      createdAt: input.createdAt,
      revokedAt: null,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...approval,
          gsiUserId: input.userId,
          gsiUserKitKey: `${input.userId}#${kitRefKey(input.kitRef)}`,
        },
      }),
    );
    return approval;
  }

  async getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userKitKey-index",
        KeyConditionExpression: "gsiUserKitKey = :k",
        ExpressionAttributeValues: { ":k": `${userId}#${kitRefKey(kitRef)}` },
      }),
    );
    const items = (result.Items ?? []).map(stripApprovalGsi);
    return items.find((a) => a.revokedAt === null);
  }

  async listApprovalsByUser(userId: string): Promise<AutoApproval[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripApprovalGsi);
  }

  async revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: approvalId },
        UpdateExpression: "SET revokedAt = :r",
        ExpressionAttributeValues: { ":r": revokedAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes ? stripApprovalGsi(result.Attributes) : undefined;
  }
}

function stripApprovalGsi(item: Record<string, unknown>): AutoApproval {
  const { gsiUserId: _u, gsiUserKitKey: _k, ...rest } = item as Record<string, unknown> & {
    gsiUserId?: string;
    gsiUserKitKey?: string;
  };
  return rest as unknown as AutoApproval;
}

// ---------------------------------------------------------------------------
// DynamoDB AutoScheduleRepository (Phase B)
// ---------------------------------------------------------------------------

/**
 * Table `AutoSchedules`, PK `id`.
 *   - GSI `userId-index`  (PK gsiUserId)        — listSchedulesByUser.
 *   - GSI `dueIndex`      (PK gsiDue, SK nextRunAt)
 *       gsiDue is a CONSTANT partition ("1") for every ENABLED schedule, and is
 *       REMOVED when a schedule is disabled. listDueSchedules then becomes a
 *       single Query on gsiDue="1" with KeyCondition nextRunAt <= now — only the
 *       enabled, actually-due rows are read (no table scan).
 *
 *       Tradeoff: a single hot partition for due-selection. At Phase B scale
 *       (cron schedules per user, swept once/minute) this is well within a
 *       partition's throughput; if it ever became hot we'd shard gsiDue by a
 *       bucket prefix and fan the sweep across buckets. Documented here so the
 *       CDK stack (agentkitauto-infra) mirrors the key schema.
 */
const DUE_PARTITION = "1";

function scheduleGsiFields(s: AutoSchedule): Record<string, unknown> {
  return {
    gsiUserId: s.userId,
    // Only enabled schedules participate in the due index.
    ...(s.enabled ? { gsiDue: DUE_PARTITION } : {}),
  };
}

export class DynamoAutoScheduleRepository implements AutoScheduleRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

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
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...schedule, ...scheduleGsiFields(schedule) },
      }),
    );
    return schedule;
  }

  async getSchedule(scheduleId: string): Promise<AutoSchedule | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: scheduleId } }),
    );
    return result.Item ? stripScheduleGsi(result.Item) : undefined;
  }

  async listSchedulesByUser(userId: string): Promise<AutoSchedule[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripScheduleGsi);
  }

  async listDueSchedules(nowISO: string): Promise<AutoSchedule[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "dueIndex",
        KeyConditionExpression: "gsiDue = :p AND nextRunAt <= :now",
        ExpressionAttributeValues: { ":p": DUE_PARTITION, ":now": nowISO },
      }),
    );
    return (result.Items ?? []).map(stripScheduleGsi);
  }

  async updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined> {
    // Read-modify-write: the due-index participation (gsiDue presence) depends on
    // the post-patch `enabled`, which is simplest to recompute from the merged
    // record and re-Put. Schedule edits are low-frequency.
    const current = await this.getSchedule(scheduleId);
    if (!current) return undefined;
    const next: AutoSchedule = {
      ...current,
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.input !== undefined ? { input: patch.input } : {}),
      ...(patch.budgetCents !== undefined ? { budgetCents: patch.budgetCents } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.approvalId !== undefined ? { approvalId: patch.approvalId } : {}),
      ...(patch.inferenceMode !== undefined ? { inferenceMode: patch.inferenceMode } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      updatedAt: patch.updatedAt,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...next, ...scheduleGsiFields(next) },
      }),
    );
    return next;
  }

  async setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: scheduleId },
        UpdateExpression:
          "SET lastRunAt = :lra, lastRunId = :lri, nextRunAt = :nra, lastError = :le",
        ExpressionAttributeValues: {
          ":lra": result.lastRunAt,
          ":lri": result.lastRunId,
          ":nra": result.nextRunAt,
          ":le": result.lastError,
        },
      }),
    );
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id: scheduleId } }),
    );
  }
}

function stripScheduleGsi(item: Record<string, unknown>): AutoSchedule {
  const { gsiUserId: _u, gsiDue: _d, ...rest } = item as Record<string, unknown> & {
    gsiUserId?: string;
    gsiDue?: string;
  };
  return rest as unknown as AutoSchedule;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface MakeAwsAutoDepsOptions {
  tables?: AutoDynamoTableNames;
  db?: DynamoDBDocumentClient;
  /** Workspace root; defaults to an OS tmp dir. */
  workspaceRootDir?: string;
}

/** Builds the AWS-backed storage deps. */
export function makeAwsAutoDeps(options: MakeAwsAutoDepsOptions = {}): AutoStorageDeps {
  const tables = options.tables ?? loadAutoDynamoTableNames();
  const db = options.db ?? createDynamoDBDocumentClient();
  const rootDir = options.workspaceRootDir ?? nodePath.join(os.tmpdir(), "agentkitauto-workspaces");
  return {
    runs: new DynamoAutoRunRepository(db, tables.runs),
    approvals: new DynamoAutoApprovalRepository(db, tables.approvals),
    schedules: new DynamoAutoScheduleRepository(db, tables.schedules),
    workspaces: new FsWorkspaceStore({ rootDir }),
  };
}
