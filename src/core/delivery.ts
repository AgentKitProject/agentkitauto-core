/**
 * Opt-in result delivery (Phase D).
 *
 * After a run reaches a TERMINAL status (success OR failure), the worker calls
 * `deliverResult` to notify the user through each configured channel:
 *
 *   - WEBHOOK: a signed JSON POST to a USER-owned https endpoint. The raw body is
 *     HMAC-SHA256 signed with `config.webhook.secret` (when present) and the hex
 *     digest is sent as `X-AutoDelivery-Signature: sha256=<hmac>`. The
 *     destination is SSRF-guarded EXACTLY like the `http_fetch` sandbox tool —
 *     https-only, DNS-resolved, with private/loopback/link-local/metadata IP
 *     ranges rejected (reusing isBlockedIp + the resolver from http-fetch). The
 *     guard, not an allowlist, is the protection: the url is the user's own
 *     endpoint, so we don't allowlist it; we only block egress to INTERNAL
 *     targets. A timeout + request-body size cap bound the POST.
 *
 *   - EMAIL: via the injected `EmailSender` port (SES on AWS, no-op self-host).
 *     The DeliveryService never knows the provider.
 *
 * SAFETY: delivery is BEST-EFFORT. `deliverResult` NEVER throws out — every
 * channel is wrapped so a delivery failure becomes a `{ status: "failed" }`
 * outcome (audited), and the run's terminal status is unaffected. Both `fetch`
 * and the DNS resolver are INJECTED so tests stay offline + deterministic.
 */

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import type { AutoRun, DeliveryConfig, DeliveryOutcome, RunTrigger } from "./types.js";
import type { AutoRunRepository, EmailSender } from "./ports.js";
import { isBlockedIp, type DnsResolver, type FetchFn } from "./http-fetch.js";

/** The final result text + status the delivery payload summarizes. */
export interface DeliveryResultInput {
  /** Terminal run status. */
  status: AutoRun["status"];
  /** Final assistant output text (truncated before sending). */
  output?: string;
  /** Total cents debited (inference + compute). */
  spentCents?: number;
}

export interface DeliverResultDeps {
  /** The run repository — used to append a `delivery` audit entry per channel. */
  runs: AutoRunRepository;
  /** Email port (provider-specific). Omit to make email channels a no-op. */
  emailSender?: EmailSender;
  /** Injected fetch (webhook POST). Omit to make webhook delivery a no-op. */
  fetchFn?: FetchFn;
  /** Injected DNS resolver (SSRF guard). Omit to make webhook delivery a no-op. */
  resolver?: DnsResolver;
  /** Max output chars included in a delivery payload/body. Default 4000. */
  maxOutputChars?: number;
  /** Webhook request timeout ms. Default 10000. */
  webhookTimeoutMs?: number;
  /** Max request-body bytes for a webhook POST. Default 64 KiB. */
  maxWebhookBodyBytes?: number;
}

export interface DeliverResultArgs {
  run: AutoRun;
  result: DeliveryResultInput;
  /** The delivery config (typically `run.deliveryConfig`). Absent → no delivery. */
  config?: DeliveryConfig;
  deps: DeliverResultDeps;
  /** Clock — ISO 8601. Injected; never an argless Date. */
  now: () => string;
}

const DEFAULT_MAX_OUTPUT_CHARS = 4000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Truncate output to a char cap (delivery never ships the whole transcript). */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

/** A short, kit-source-agnostic label for the run's kit. */
function kitRefLabel(run: AutoRun): string {
  const ref = run.kitRef;
  if (ref.source === "market") return ref.slug ?? ref.marketKitId ?? "market-kit";
  return ref.localKitId ?? "local-kit";
}

/**
 * The signed webhook JSON payload. Stable, minimal, non-sensitive: no system
 * prompt, no audit log, no workspace files — just the run summary.
 */
export interface DeliveryWebhookPayload {
  runId: string;
  status: AutoRun["status"];
  kitRef: AutoRun["kitRef"];
  finishedAt: string;
  /** Truncated final output. */
  output: string;
  spentCents: number;
  trigger: RunTrigger;
}

/** Build the canonical webhook payload object for a run. */
export function buildWebhookPayload(
  run: AutoRun,
  result: DeliveryResultInput,
  finishedAt: string,
  maxOutputChars: number,
): DeliveryWebhookPayload {
  return {
    runId: run.id,
    status: result.status,
    kitRef: run.kitRef,
    finishedAt,
    output: truncate(result.output ?? "", maxOutputChars),
    spentCents: result.spentCents ?? run.spentCents ?? 0,
    trigger: run.trigger ?? "on_demand",
  };
}

/** Compute `sha256=<hex hmac>` over `body` with `secret`. */
export function signWebhookBody(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hmac}`;
}

/**
 * SSRF guard for a webhook destination — the SAME policy as the http_fetch tool,
 * minus the allowlist (the url is the user's own endpoint). Throws on a guard
 * failure (non-https / unresolvable / private-IP). Reuses isBlockedIp + resolver.
 */
async function assertWebhookDestinationSafe(url: string, resolver: DnsResolver): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook url: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Webhook url must be https (got ${parsed.protocol}).`);
  }
  // URL.hostname keeps the brackets on a literal IPv6 host (e.g. "[::1]");
  // strip them so the IP check sees the bare address.
  const rawHost = parsed.hostname;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  // Literal-IP host: check directly. Named host: resolve and require EVERY
  // resolved IP to be public (defeats DNS-rebinding to an internal address).
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new Error(`Webhook host IP "${host}" is in a blocked (private/loopback/link-local) range.`);
    }
    return;
  }
  let ips: string[];
  try {
    ips = await resolver(host);
  } catch (err) {
    throw new Error(`Could not resolve webhook host "${host}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ips.length === 0) {
    throw new Error(`Webhook host "${host}" did not resolve to any address.`);
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new Error(`Webhook host "${host}" resolves to a blocked address (${ip}).`);
    }
  }
}

/** Deliver to the webhook channel. Never throws — returns a typed outcome. */
async function deliverWebhook(
  args: DeliverResultArgs,
  webhook: NonNullable<DeliveryConfig["webhook"]>,
  finishedAt: string,
): Promise<{ status: "delivered" | "failed"; error?: string }> {
  const { run, result, deps } = args;
  const { fetchFn, resolver } = deps;
  if (!fetchFn || !resolver) {
    return { status: "failed", error: "Webhook delivery is unavailable (no fetch/resolver wired)." };
  }
  const maxOutputChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const maxBodyBytes = deps.maxWebhookBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  const timeoutMs = deps.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;

  try {
    await assertWebhookDestinationSafe(webhook.url, resolver);

    const payload = buildWebhookPayload(run, result, finishedAt, maxOutputChars);
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
      return { status: "failed", error: `Webhook payload exceeds the ${maxBodyBytes}-byte cap.` };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "AgentKitAuto-Delivery/1",
    };
    if (webhook.secret) {
      headers["X-AutoDelivery-Signature"] = signWebhookBody(body, webhook.secret);
    } else {
      // No secret → unsigned. Make that explicit so the receiver can decide.
      headers["X-AutoDelivery-Signature"] = "none";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        return { status: "delivered" };
      }
      return { status: "failed", error: `Webhook responded with HTTP ${res.status}.` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Deliver to the email channel. Never throws — returns a typed outcome. */
async function deliverEmail(
  args: DeliverResultArgs,
  recipients: string[],
): Promise<{ status: "delivered" | "failed" | "skipped"; error?: string }> {
  const { run, result, deps } = args;
  const sender = deps.emailSender;
  if (!sender) {
    return { status: "skipped", error: "Email delivery is unavailable (no EmailSender wired)." };
  }
  if (recipients.length === 0) {
    return { status: "skipped", error: "No recipients." };
  }
  const maxOutputChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const kit = kitRefLabel(run);
  const subject = `[AgentKitAuto] ${kit} run ${result.status}`;
  const text =
    `Run ${run.id} (${kit}) finished: ${result.status}.\n\n` +
    `Output:\n${truncate(result.output ?? "", maxOutputChars)}\n`;
  try {
    const out = await sender.sendEmail({ to: recipients, subject, text });
    return out;
  } catch (err) {
    // The port contract says implementations shouldn't throw, but defend anyway.
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Deliver a finished run's result through every configured channel. Best-effort:
 * collects per-channel outcomes, audits each, and NEVER throws out (a delivery
 * failure must not fail the run). Returns the aggregate per-channel result, or
 * `{}` when there is no deliveryConfig / no channels.
 */
export async function deliverResult(args: DeliverResultArgs): Promise<DeliveryOutcome> {
  const { run, deps, now } = args;
  const config = args.config ?? run.deliveryConfig;
  const outcome: DeliveryOutcome = {};
  if (!config) return outcome;

  const finishedAt = run.finishedAt ?? now();

  const audit = async (channel: "email" | "webhook", status: string, detail?: string): Promise<void> => {
    await deps.runs
      .appendAudit(run.id, {
        tool: "delivery",
        argsSummary: `channel=${channel}`,
        outcome: status === "delivered" ? "ok" : status === "skipped" ? "rejected" : "error",
        ts: now(),
        ...(detail ? { detail } : {}),
      })
      .catch(() => {});
  };

  // Webhook channel.
  if (config.webhook) {
    const r = await deliverWebhook(args, config.webhook, finishedAt);
    outcome.webhook = r.error ? { status: r.status, error: r.error } : { status: r.status };
    await audit("webhook", r.status, r.error);
  }

  // Email channel.
  if (config.email && config.email.length > 0) {
    const r = await deliverEmail(args, config.email);
    outcome.email = r.error ? { status: r.status, error: r.error } : { status: r.status };
    await audit("email", r.status, r.error);
  }

  return outcome;
}
