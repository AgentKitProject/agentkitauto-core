/**
 * Unit tests for the HTTP kit-context resolver used by the Fargate worker.
 *
 * Covers:
 *   - fetchResolveContext happy path (parses tools/toolNames/inferenceMode),
 *   - non-2xx throws WITHOUT leaking the response body,
 *   - the request carries the bearer + x-service-key headers and POSTs {runId},
 *   - toResolveKitContext yields the kit fields,
 *   - integration through processAutoRun with the in-memory harness.
 */

import { describe, expect, it, vi } from "vitest";
import {
  fetchResolveContext,
  toResolveKitContext,
  type ResolveContextResponse,
} from "../src/core/http-resolve-context.js";
import {
  processAutoRun,
  type ResolveKitContext,
} from "../src/entrypoints/worker.js";
import type { AutoStorageDeps } from "../src/core/ports.js";
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

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function errResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

const happyPayload: ResolveContextResponse = {
  systemPrompt: "you are a kit",
  kitContext: "kit ctx",
  tools: [{ name: "read_file", description: "read", inputSchema: {} }],
  toolNames: ["read_file"],
  model: "claude-sonnet-4-6",
  inferenceMode: "managed",
};

describe("fetchResolveContext", () => {
  it("returns the parsed payload incl tools/toolNames/inferenceMode", async () => {
    const fetchImpl = vi.fn(async () => okResponse(happyPayload));
    const out = await fetchResolveContext({
      runId: "run-1",
      baseUrl: "https://forge.example.com",
      serviceKey: "svc-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.tools).toEqual(happyPayload.tools);
    expect(out.toolNames).toEqual(["read_file"]);
    expect(out.inferenceMode).toBe("managed");
    expect(out.systemPrompt).toBe("you are a kit");
  });

  it("posts {runId} with bearer + x-service-key headers to the resolve endpoint", async () => {
    const fetchImpl = vi.fn(async () => okResponse(happyPayload));
    await fetchResolveContext({
      runId: "run-abc",
      baseUrl: "https://forge.example.com/",
      serviceKey: "svc-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://forge.example.com/api/internal/auto/resolve-context");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer svc-key");
    expect(headers["x-service-key"]).toBe("svc-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ runId: "run-abc" });
  });

  it("throws on non-2xx WITHOUT leaking the response body", async () => {
    const secret = "SECRET-PROMPT-CONTENTS";
    const fetchImpl = vi.fn(async () => errResponse(403, { systemPrompt: secret }));
    await expect(
      fetchResolveContext({
        runId: "run-1",
        baseUrl: "https://forge.example.com",
        serviceKey: "svc-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/resolve-context failed: HTTP 403/);
    // The thrown message must not contain the body.
    await fetchResolveContext({
      runId: "run-1",
      baseUrl: "https://forge.example.com",
      serviceKey: "svc-key",
      fetchImpl: (async () => okResponse(happyPayload)) as unknown as typeof fetch,
    });
    try {
      await fetchResolveContext({
        runId: "run-1",
        baseUrl: "https://forge.example.com",
        serviceKey: "svc-key",
        fetchImpl: (async () => errResponse(403, { systemPrompt: secret })) as unknown as typeof fetch,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("throws on malformed payload (tools not an array)", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ tools: "nope", toolNames: [], inferenceMode: "managed" }),
    );
    await expect(
      fetchResolveContext({
        runId: "run-1",
        baseUrl: "https://forge.example.com",
        serviceKey: "svc-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/malformed/i);
  });

  it("throws when inferenceMode is missing", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ tools: [], toolNames: [] }));
    await expect(
      fetchResolveContext({
        runId: "run-1",
        baseUrl: "https://forge.example.com",
        serviceKey: "svc-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/inferenceMode/i);
  });
});

describe("toResolveKitContext", () => {
  it("yields the kit fields from the payload", async () => {
    const hook = toResolveKitContext(happyPayload);
    const resolved = await hook(
      {} as Parameters<ResolveKitContext>[0],
      {} as Parameters<ResolveKitContext>[1],
    );
    expect(resolved.systemPrompt).toBe("you are a kit");
    expect(resolved.kitContext).toBe("kit ctx");
    expect(resolved.tools).toEqual(happyPayload.tools);
    expect(resolved.toolNames).toEqual(["read_file"]);
  });

  it("omits systemPrompt/kitContext when absent", async () => {
    const hook = toResolveKitContext({
      tools: [],
      toolNames: [],
      inferenceMode: "managed",
    });
    const resolved = await hook(
      {} as Parameters<ResolveKitContext>[0],
      {} as Parameters<ResolveKitContext>[1],
    );
    expect("systemPrompt" in resolved).toBe(false);
    expect("kitContext" in resolved).toBe(false);
  });
});

class FundedLedger implements CreditLedgerRepository {
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
  async reserveHold() {
    return "h-1";
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

describe("toResolveKitContext drives processAutoRun", () => {
  it("resolves kit context from a fetched payload through the worker", async () => {
    const fetchImpl = (async () => okResponse(happyPayload)) as unknown as typeof fetch;
    const payload = await fetchResolveContext({
      runId: "run-1",
      baseUrl: "https://forge.example.com",
      serviceKey: "svc-key",
      fetchImpl,
    });

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
    const run = await runs.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "x" },
      budgetCents: 100,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
    });

    const out = await processAutoRun(run.id, {
      storage,
      chatProvider: new FakeChatProvider([textResponse("done")]),
      ledger: new FundedLedger(),
      resolveKitContext: toResolveKitContext(payload),
      inferenceMode: payload.inferenceMode,
      now: noopNow,
    });
    expect(out.status).toBe("succeeded");
  });
});
