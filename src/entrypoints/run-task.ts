/**
 * run-task — the Fargate task main for AgentKitAuto.
 *
 * ECS launches one task per run, passing `RUN_ID` in the environment. This
 * entrypoint wires the AWS-backed storage (via the task role — no static keys),
 * the platform Anthropic provider + credit ledger, and an HTTP-backed kit-context
 * resolver, then executes the run end-to-end via `processAutoRun`.
 *
 * `runTask` is kept PURE (it throws on failure rather than calling
 * `process.exit`), so it stays unit-testable. `main()` is the process wrapper:
 * it catches and maps any rejection (or a "failed" terminal status) to a
 * non-zero exit so ECS marks the task failed.
 *
 * Security: NEVER log the system prompt, kit context, or a BYO API key. On
 * success we log only the run id + terminal status.
 */

import {
  AnthropicChatProvider,
  DynamoCreditLedgerRepository,
  createDynamoDBDocumentClient,
  createManagedAnthropicProvider,
  loadDynamoTableNames,
  type ChatProvider,
} from "@agentkitforge/gateway-core";
import { lookup } from "node:dns/promises";
import type { InferenceMode } from "../core/types.js";
import { awsClientEnv, makeAwsAutoDeps } from "../adapters/aws/index.js";
import { makeSesEmailSender } from "../adapters/aws/ses-email-sender.js";
import type { DnsResolver, FetchFn } from "../core/http-fetch.js";
import {
  fetchResolveContext,
  toResolveKitContext,
} from "../core/http-resolve-context.js";
import { processAutoRun, type ProcessAutoRunDeps } from "./worker.js";

/** Real DNS resolver for webhook-delivery SSRF guard (A + AAAA). */
const dnsResolver: DnsResolver = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/** Global fetch adapted to the injected FetchFn shape (webhook delivery). */
const globalFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init as RequestInit | undefined);
  return {
    status: res.status,
    headers: { forEach: (cb) => res.headers.forEach(cb) },
    text: () => res.text(),
  };
};

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseIntEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

/**
 * Executes the run identified by `RUN_ID`. Pure: throws on any failure (missing
 * env, denied approval, or a "failed" terminal status) so the caller decides
 * the exit code.
 */
export async function runTask(env: Env = process.env): Promise<void> {
  const runId = requireEnv(env, "RUN_ID");
  // The web-forge internal resolve endpoint + its service key. These names match
  // the ECS task-def env injected by the CDK stack and the web app's config.
  const resolveBaseUrl = requireEnv(env, "WEB_FORGE_INTERNAL_URL");
  const resolveServiceKey = requireEnv(env, "AUTO_WORKER_SERVICE_KEY");

  // Storage uses the task role (default credential chain) — no static keys.
  // Phase D (hardened isolation): when the hosted Fargate task runs with a
  // read-only root filesystem, the only writable path is the mounted scratch
  // volume; AUTO_WORKSPACE_DIR points the per-run workspace store there. When
  // unset (self-host / dev / pre-Phase-D), makeAwsAutoDeps falls back to the
  // os.tmpdir() default, so this is backward-compatible.
  const workspaceRootDir = env["AUTO_WORKSPACE_DIR"];
  const storage = makeAwsAutoDeps(
    workspaceRootDir && workspaceRootDir.trim() !== ""
      ? { workspaceRootDir }
      : {},
  );

  // Platform (managed) provider + credit ledger.
  const chatProvider = createManagedAnthropicProvider();
  const ledger = new DynamoCreditLedgerRepository(
    createDynamoDBDocumentClient(awsClientEnv(env)),
    loadDynamoTableNames(env),
  );

  // Single up-front fetch of the resolve payload: it carries BOTH the kit
  // context AND the per-run inference mode / BYO provider config. We reuse the
  // same payload for the resolveKitContext hook to avoid a second round-trip.
  const payload = await fetchResolveContext({
    runId,
    baseUrl: resolveBaseUrl,
    serviceKey: resolveServiceKey,
  });

  const inferenceMode: InferenceMode = payload.inferenceMode;

  // BYO provider: only when the run is BYO and the resolver returned a key.
  let byoChatProvider: ChatProvider | undefined;
  if (inferenceMode === "byo" && payload.byoProvider) {
    byoChatProvider = new AnthropicChatProvider({
      apiKey: payload.byoProvider.apiKey,
      ...(payload.byoProvider.baseUrl !== undefined
        ? { baseUrl: payload.byoProvider.baseUrl }
        : {}),
    });
  }

  const markupBps = parseIntEnv(env, "AUTO_MARKUP_BPS", 2500);

  const deps: ProcessAutoRunDeps = {
    storage,
    chatProvider,
    ...(byoChatProvider ? { byoChatProvider } : {}),
    inferenceMode,
    ledger,
    resolveKitContext: toResolveKitContext(payload),
    now: () => new Date().toISOString(),
    markupBps,
    // Opt-in result delivery (Phase D). SES sender is inert when SES_SENDER is
    // unset; webhook delivery uses global fetch + a real DNS resolver behind the
    // SSRF guard. All best-effort — a delivery failure never fails the run.
    emailSender: makeSesEmailSender(
      { clientConfig: { region: env["FORGE_AWS_REGION"] || env["AWS_REGION"] || "us-east-1" } },
      env,
    ),
    deliveryFetch: globalFetch,
    deliveryResolver: dnsResolver,
    ...(env["AUTO_MAX_TOKENS"] !== undefined
      ? { maxTokens: parseIntEnv(env, "AUTO_MAX_TOKENS", 0) }
      : {}),
    ...(env["AUTO_MAX_TOOL_ROUNDS"] !== undefined
      ? { maxToolRounds: parseIntEnv(env, "AUTO_MAX_TOOL_ROUNDS", 0) }
      : {}),
  };

  const result = await processAutoRun(runId, deps);

  if (result.status === "failed") {
    // Throw (no prompt) so main() maps it to a non-zero exit.
    throw new Error(`Auto run ${runId} finished: failed`);
  }

  // Status only — never the prompt or any output.
  console.log(`Auto run ${runId} finished: ${result.status}`);
}

/** Process wrapper: run, then exit non-zero on any rejection. */
export async function main(): Promise<void> {
  try {
    await runTask();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Auto run failed: ${message}`);
    process.exit(1);
  }
}

// Standard ESM entry guard: only run when invoked directly (the task main),
// not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
