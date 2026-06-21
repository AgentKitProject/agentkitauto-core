/**
 * In-memory test fakes for the Auto core ports + a deterministic fake
 * ChatProvider, so driver/executor tests run offline with no real model.
 */

import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  CreditLedgerRepository,
  StreamEvent,
} from "@agentkitforge/gateway-core";
import type { AutoRunRepository, WorkspaceStore } from "../src/core/ports.js";
import type {
  AuditEntry,
  AutoRun,
  AutoRunResult,
  AutoRunStatus,
  CreateRunInput,
  WorkspaceFileEntry,
} from "../src/core/types.js";

let runSeq = 0;

export class InMemoryRunRepo implements AutoRunRepository {
  runs = new Map<string, AutoRun>();

  seed(run: AutoRun): AutoRun {
    this.runs.set(run.id, run);
    return run;
  }

  async createRun(input: CreateRunInput): Promise<AutoRun> {
    const run: AutoRun = {
      id: `run-${++runSeq}`,
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
      ...(input.deliveryConfig !== undefined ? { deliveryConfig: input.deliveryConfig } : {}),
      auditLog: [],
      cancelRequested: false,
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }

  async getRun(runId: string): Promise<AutoRun | undefined> {
    const r = this.runs.get(runId);
    return r ? structuredClone(r) : undefined;
  }

  async listRunsByUser(userId: string, limit = 50): Promise<AutoRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.userId === userId)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields: {
      startedAt?: string;
      finishedAt?: string;
      error?: string;
      workspaceId?: string;
      spentInferenceCents?: number;
      spentComputeCents?: number;
    } = {},
  ): Promise<AutoRun | undefined> {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    r.status = status;
    if (fields.startedAt) r.startedAt = fields.startedAt;
    if (fields.finishedAt) r.finishedAt = fields.finishedAt;
    if (fields.error) r.error = fields.error;
    if (fields.workspaceId) r.workspaceId = fields.workspaceId;
    if (fields.spentInferenceCents !== undefined) r.spentInferenceCents = fields.spentInferenceCents;
    if (fields.spentComputeCents !== undefined) r.spentComputeCents = fields.spentComputeCents;
    return structuredClone(r);
  }

  async appendAudit(runId: string, entry: AuditEntry): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.auditLog.push(entry);
  }

  async setResult(runId: string, result: AutoRunResult): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.result = result;
  }

  async recordSpend(runId: string, deltaCents: number): Promise<number> {
    const r = this.runs.get(runId);
    if (!r) return deltaCents;
    r.spentCents += deltaCents;
    return r.spentCents;
  }

  async requestCancel(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.cancelRequested = true;
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    return this.runs.get(runId)?.cancelRequested === true;
  }
}

/** A minimal in-memory workspace for executor tests (path confinement is tested
 *  separately against the real FsWorkspaceStore). */
export class InMemoryWorkspace implements WorkspaceStore {
  files = new Map<string, Map<string, string>>();

  async createWorkspace(runId: string): Promise<string> {
    const id = `ws-${runId}`;
    this.files.set(id, new Map());
    return id;
  }
  private ws(id: string): Map<string, string> {
    const m = this.files.get(id);
    if (!m) throw new Error(`workspace not found: ${id}`);
    return m;
  }
  async readFile(workspaceId: string, path: string): Promise<string> {
    const v = this.ws(workspaceId).get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async listDir(workspaceId: string): Promise<string[]> {
    return [...this.ws(workspaceId).keys()];
  }
  async writeFile(workspaceId: string, path: string, content: string): Promise<void> {
    this.ws(workspaceId).set(path, content);
  }
  async bundleResult(workspaceId: string): Promise<WorkspaceFileEntry[]> {
    return [...this.ws(workspaceId).entries()].map(([path, content]) => ({
      path,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    }));
  }
  async cleanup(workspaceId: string): Promise<void> {
    this.files.delete(workspaceId);
  }
}

/**
 * Scripted fake ChatProvider: returns the next queued ChatResponse on each
 * sendMessage call. Deterministic + offline.
 */
export class FakeChatProvider implements ChatProvider {
  readonly providerType = "fake";
  private queue: ChatResponse[];
  calls = 0;

  constructor(responses: ChatResponse[]) {
    this.queue = [...responses];
  }

  async sendMessage(_request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    const next = this.queue.shift();
    if (!next) throw new Error("FakeChatProvider: no more scripted responses");
    return next;
  }

  async streamMessage(
    request: ChatRequest,
    _onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse> {
    return this.sendMessage(request);
  }
}

/** Build a ChatResponse with text + optional tool_use blocks. */
export function textResponse(text: string, outputTokens = 100): ChatResponse {
  return {
    content: [{ type: "text", text }] as ContentBlock[],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0 },
  };
}

export function toolUseResponse(
  toolName: string,
  input: Record<string, unknown>,
  id = "tu-1",
  outputTokens = 100,
): ChatResponse {
  return {
    content: [{ type: "tool_use", id, name: toolName, input }] as ContentBlock[],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0 },
  };
}

export const noopNow = (): string => "2026-06-18T00:00:00.000Z";
