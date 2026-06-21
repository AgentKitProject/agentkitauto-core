/**
 * Result delivery (Phase D) — DeliveryService unit tests. Fully offline: fetch,
 * the DNS resolver, and the EmailSender are all injected.
 *
 * Asserts:
 *   - webhook payload shape + HMAC-SHA256 signature (verified with a known key);
 *   - webhook https-only enforced;
 *   - webhook SSRF guard rejects private / loopback / link-local / metadata
 *     (literal-IP host AND a resolver that returns a blocked address);
 *   - webhook timeout + body size cap;
 *   - webhook unsigned (signature header "none") when no secret;
 *   - email sender called with the right to/subject/body;
 *   - delivery failures never throw, are recorded as outcomes, and are audited;
 *   - absent deliveryConfig → no delivery.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildWebhookPayload,
  deliverResult,
  signWebhookBody,
  type DeliverResultArgs,
} from "../src/core/delivery.js";
import type { DnsResolver, FetchFn } from "../src/core/http-fetch.js";
import type { EmailSender, OutboundEmail } from "../src/core/ports.js";
import type { AutoRun, DeliveryConfig } from "../src/core/types.js";
import { InMemoryRunRepo, noopNow } from "./fakes.js";

const publicResolver: DnsResolver = async () => ["93.184.216.34"];

function fakeFetch(
  status = 200,
): { fn: FetchFn; calls: { url: string; init?: Parameters<FetchFn>[1] }[] } {
  const calls: { url: string; init?: Parameters<FetchFn>[1] }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return {
      status,
      headers: { forEach() {} },
      async text() {
        return "ok";
      },
    };
  };
  return { fn, calls };
}

function makeRun(overrides: Partial<AutoRun> = {}): AutoRun {
  return {
    id: "run-x",
    userId: "u1",
    kitRef: { source: "market", marketKitId: "mk1", slug: "cool-kit" },
    status: "succeeded",
    input: { prompt: "do it" },
    budgetCents: 500,
    spentCents: 42,
    model: "claude-sonnet-4-6",
    createdAt: noopNow(),
    finishedAt: "2026-06-18T00:05:00.000Z",
    auditLog: [],
    trigger: "on_demand",
    ...overrides,
  };
}

async function runDeliver(
  config: DeliveryConfig,
  opts: {
    run?: AutoRun;
    result?: DeliverResultArgs["result"];
    fetchFn?: FetchFn;
    resolver?: DnsResolver;
    emailSender?: EmailSender;
    maxWebhookBodyBytes?: number;
    webhookTimeoutMs?: number;
  } = {},
) {
  const runs = new InMemoryRunRepo();
  const run = opts.run ?? makeRun();
  runs.seed(run);
  const out = await deliverResult({
    run,
    result:
      opts.result ?? { status: run.status, output: run.result?.output ?? "the answer", spentCents: run.spentCents },
    config,
    deps: {
      runs,
      ...(opts.emailSender ? { emailSender: opts.emailSender } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.resolver ? { resolver: opts.resolver } : {}),
      ...(opts.maxWebhookBodyBytes !== undefined ? { maxWebhookBodyBytes: opts.maxWebhookBodyBytes } : {}),
      ...(opts.webhookTimeoutMs !== undefined ? { webhookTimeoutMs: opts.webhookTimeoutMs } : {}),
    },
    now: noopNow,
  });
  return { out, runs, run };
}

describe("signWebhookBody / buildWebhookPayload", () => {
  it("produces a stable, minimal payload", () => {
    const run = makeRun();
    const payload = buildWebhookPayload(run, { status: "succeeded", output: "x", spentCents: 7 }, run.finishedAt!, 4000);
    expect(payload).toEqual({
      runId: "run-x",
      status: "succeeded",
      kitRef: run.kitRef,
      finishedAt: run.finishedAt,
      output: "x",
      spentCents: 7,
      trigger: "on_demand",
    });
  });

  it("signs with HMAC-SHA256 over the raw body (verifiable with a known key)", () => {
    const body = JSON.stringify({ a: 1 });
    const expected = `sha256=${createHmac("sha256", "topsecret").update(body, "utf8").digest("hex")}`;
    expect(signWebhookBody(body, "topsecret")).toBe(expected);
  });
});

describe("deliverResult — webhook", () => {
  it("POSTs a signed payload whose HMAC verifies with the secret", async () => {
    const { fn, calls } = fakeFetch();
    const { out } = await runDeliver(
      { webhook: { url: "https://hooks.example.com/auto", secret: "s3cr3t" } },
      { fetchFn: fn, resolver: publicResolver },
    );
    expect(out.webhook?.status).toBe("delivered");
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    const body = sent.init!.body as string;
    const sig = sent.init!.headers!["X-AutoDelivery-Signature"];
    const expected = `sha256=${createHmac("sha256", "s3cr3t").update(body, "utf8").digest("hex")}`;
    expect(sig).toBe(expected);
    expect(sent.init!.headers!["content-type"]).toBe("application/json");
    // Body is the canonical payload.
    expect(JSON.parse(body)).toMatchObject({ runId: "run-x", status: "succeeded", spentCents: 42 });
  });

  it("sends UNSIGNED (signature 'none') when no secret is configured", async () => {
    const { fn, calls } = fakeFetch();
    const { out } = await runDeliver(
      { webhook: { url: "https://hooks.example.com/auto" } },
      { fetchFn: fn, resolver: publicResolver },
    );
    expect(out.webhook?.status).toBe("delivered");
    expect(calls[0]!.init!.headers!["X-AutoDelivery-Signature"]).toBe("none");
  });

  it("rejects non-https destinations", async () => {
    const { fn, calls } = fakeFetch();
    const { out } = await runDeliver(
      { webhook: { url: "http://hooks.example.com/auto" } },
      { fetchFn: fn, resolver: publicResolver },
    );
    expect(out.webhook?.status).toBe("failed");
    expect(out.webhook?.error).toMatch(/https/i);
    expect(calls).toHaveLength(0); // never reached the network
  });

  it("SSRF-guards a literal private/loopback/link-local/metadata IP host", async () => {
    for (const host of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "[::1]"]) {
      const { fn, calls } = fakeFetch();
      const { out } = await runDeliver(
        { webhook: { url: `https://${host}/hook` } },
        { fetchFn: fn, resolver: publicResolver },
      );
      expect(out.webhook?.status, host).toBe("failed");
      expect(out.webhook?.error, host).toMatch(/blocked|private|loopback|link-local/i);
      expect(calls, host).toHaveLength(0);
    }
  });

  it("SSRF-guards a named host that RESOLVES to a blocked address", async () => {
    const rebind: DnsResolver = async () => ["169.254.169.254"]; // metadata
    const { fn, calls } = fakeFetch();
    const { out } = await runDeliver(
      { webhook: { url: "https://evil.example.com/hook" } },
      { fetchFn: fn, resolver: rebind },
    );
    expect(out.webhook?.status).toBe("failed");
    expect(out.webhook?.error).toMatch(/blocked address/i);
    expect(calls).toHaveLength(0);
  });

  it("fails (not throws) on a webhook timeout (abort)", async () => {
    // A fetch that respects the abort signal and rejects like the platform does.
    const fn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted.");
          e.name = "AbortError";
          reject(e);
        });
      });
    const { out } = await runDeliver(
      { webhook: { url: "https://slow.example.com/hook" } },
      { fetchFn: fn, resolver: publicResolver, webhookTimeoutMs: 5 },
    );
    expect(out.webhook?.status).toBe("failed");
    expect(out.webhook?.error).toMatch(/abort/i);
  });

  it("fails when the payload exceeds the body size cap", async () => {
    const { fn, calls } = fakeFetch();
    const bigRun = makeRun();
    const { out } = await runDeliver(
      { webhook: { url: "https://hooks.example.com/auto" } },
      {
        run: bigRun,
        result: { status: "succeeded", output: "x".repeat(10_000), spentCents: 1 },
        fetchFn: fn,
        resolver: publicResolver,
        maxWebhookBodyBytes: 64,
      },
    );
    expect(out.webhook?.status).toBe("failed");
    expect(out.webhook?.error).toMatch(/cap/i);
    expect(calls).toHaveLength(0);
  });

  it("fails when the receiver returns a non-2xx status", async () => {
    const { fn } = fakeFetch(500);
    const { out } = await runDeliver(
      { webhook: { url: "https://hooks.example.com/auto" } },
      { fetchFn: fn, resolver: publicResolver },
    );
    expect(out.webhook?.status).toBe("failed");
    expect(out.webhook?.error).toMatch(/HTTP 500/);
  });
});

describe("deliverResult — email", () => {
  it("calls the EmailSender with the right to/subject/body", async () => {
    const seen: OutboundEmail[] = [];
    const sender: EmailSender = {
      async sendEmail(email) {
        seen.push(email);
        return { status: "delivered" };
      },
    };
    const { out } = await runDeliver(
      { email: ["a@example.com", "b@example.com"] },
      { emailSender: sender, result: { status: "failed", output: "boom", spentCents: 3 } },
    );
    expect(out.email?.status).toBe("delivered");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.to).toEqual(["a@example.com", "b@example.com"]);
    expect(seen[0]!.subject).toBe("[AgentKitAuto] cool-kit run failed");
    expect(seen[0]!.text).toMatch(/finished: failed/);
    expect(seen[0]!.text).toMatch(/boom/);
  });

  it("skips email when no EmailSender is wired (SES_SENDER-unset analog)", async () => {
    const { out } = await runDeliver({ email: ["a@example.com"] }, {});
    expect(out.email?.status).toBe("skipped");
  });

  it("propagates a sender's failed/skipped outcome without throwing", async () => {
    const sender: EmailSender = {
      async sendEmail() {
        return { status: "skipped", error: "SES_SENDER is not configured." };
      },
    };
    const { out } = await runDeliver({ email: ["a@example.com"] }, { emailSender: sender });
    expect(out.email?.status).toBe("skipped");
    expect(out.email?.error).toMatch(/SES_SENDER/);
  });
});

describe("deliverResult — outcomes + audit + best-effort", () => {
  it("audits one 'delivery' entry per channel", async () => {
    const { fn } = fakeFetch();
    const sender: EmailSender = { async sendEmail() { return { status: "delivered" }; } };
    const { out, runs, run } = await runDeliver(
      { webhook: { url: "https://hooks.example.com/auto", secret: "k" }, email: ["a@example.com"] },
      { fetchFn: fn, resolver: publicResolver, emailSender: sender },
    );
    expect(out.webhook?.status).toBe("delivered");
    expect(out.email?.status).toBe("delivered");
    const audited = (await runs.getRun(run.id))!.auditLog.filter((e) => e.tool === "delivery");
    expect(audited.map((e) => e.argsSummary).sort()).toEqual(["channel=email", "channel=webhook"]);
    expect(audited.every((e) => e.outcome === "ok")).toBe(true);
  });

  it("returns {} and does NOT audit when there is no deliveryConfig", async () => {
    const runs = new InMemoryRunRepo();
    const run = makeRun();
    runs.seed(run);
    const out = await deliverResult({
      run,
      result: { status: "succeeded", output: "x" },
      deps: { runs },
      now: noopNow,
    });
    expect(out).toEqual({});
    expect((await runs.getRun(run.id))!.auditLog).toHaveLength(0);
  });

  it("a webhook delivery failure never throws and is audited as error", async () => {
    const fn: FetchFn = async () => {
      throw new Error("connection refused");
    };
    const { out, runs, run } = await runDeliver(
      { webhook: { url: "https://hooks.example.com/auto" } },
      { fetchFn: fn, resolver: publicResolver },
    );
    expect(out.webhook?.status).toBe("failed");
    expect(out.webhook?.error).toMatch(/connection refused/);
    const audited = (await runs.getRun(run.id))!.auditLog.find((e) => e.tool === "delivery");
    expect(audited?.outcome).toBe("error");
  });
});
