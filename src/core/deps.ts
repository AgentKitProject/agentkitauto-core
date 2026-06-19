/**
 * makeAutoDeps — the storage-layer composition factory, mirroring the store
 * factories in gateway-core / market-core. Selects the AWS (DynamoDB) or
 * self-host (Postgres) backend and returns the AutoStorageDeps bundle the
 * worker + run-driver consume.
 *
 * The CHAT/BILLING deps (ChatProvider, CreditLedgerRepository) are NOT built
 * here — those come from @agentkitforge/gateway-core's own composition (the
 * platform Anthropic provider + the gateway ledger adapter), injected into the
 * run-driver at the entrypoint. Auto never owns billing.
 */

import type { AutoStorageDeps } from "./ports.js";
import {
  makeAwsAutoDeps,
  type MakeAwsAutoDepsOptions,
} from "../adapters/aws/index.js";
import {
  makeSelfHostAutoDeps,
  type MakeSelfHostAutoDepsOptions,
} from "../adapters/selfhost/postgres.js";

export type AutoBackend = "aws" | "selfhost";

export type MakeAutoDepsOptions =
  | ({ backend: "aws" } & MakeAwsAutoDepsOptions)
  | ({ backend: "selfhost" } & MakeSelfHostAutoDepsOptions);

/** Builds the storage deps for the selected backend. */
export function makeAutoDeps(options: MakeAutoDepsOptions): AutoStorageDeps {
  if (options.backend === "aws") {
    const { backend: _b, ...rest } = options;
    return makeAwsAutoDeps(rest);
  }
  const { backend: _b, ...rest } = options;
  return makeSelfHostAutoDeps(rest);
}
