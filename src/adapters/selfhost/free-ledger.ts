/**
 * No-op credit ledger for the self-host FREE billing policy.
 *
 * Self-host Auto runs default to FREE: the operator supplies their own
 * ANTHROPIC_API_KEY, every run is BYO (inferenceMode "byo"), and the dispatcher
 * declares isCloudRun=false. In that configuration the run-driver NEVER touches
 * the credit ledger — `chargeCompute` is only true when
 * (isCloudRun && byo && cloudRunCentsPerMin > 0), and managed turns are the only
 * other ledger consumer. So a self-host free deployment needs a ledger object to
 * satisfy ProcessAutoRunDeps, but it is never actually exercised.
 *
 * This implementation provides safe inert values for the read/account methods and
 * THROWS on the spend paths (reserveHold/settleHold/debit/topup). If any of those
 * is ever reached on a self-host free deployment it is a configuration error
 * (e.g. AUTO_SELFHOST_BILLING left at "free" while a managed/cloud run was
 * dispatched) and should fail loudly rather than silently grant unmetered managed
 * inference. A self-hoster who wants metered/managed billing should instead inject
 * the gateway-core PostgresCreditLedgerRepository.
 */

import type {
  CreditAccount,
  CreditHold,
  CreditLedgerRepository,
  CreditTransaction,
  RecordTransactionInput,
} from "@agentkitforge/gateway-core";

function unmetered(method: string): never {
  throw new Error(
    `[auto-core] self-host FREE billing: ledger.${method} was called but self-host free runs must never touch the credit ledger. ` +
      `Set AUTO_SELFHOST_BILLING=managed and inject a real CreditLedgerRepository to enable metered billing.`,
  );
}

/** A zero-balance, never-funded account snapshot for the read paths. */
function emptyAccount(userId: string, now: string): CreditAccount {
  return {
    userId,
    availableBalanceCents: 0,
    heldBalanceCents: 0,
    lifetimeTopupCents: 0,
    updatedAt: now,
  };
}

/** Build the inert self-host free-billing ledger. */
export function makeFreeCreditLedger(): CreditLedgerRepository {
  return {
    async getAccount(): Promise<CreditAccount | undefined> {
      return undefined;
    },
    async ensureAccount(userId: string, now: string): Promise<CreditAccount> {
      // ensureAccount is read-shaped (idempotent existence guarantee); return an
      // empty snapshot so a defensive caller doesn't crash. It does NOT grant
      // balance — the spend methods still throw.
      return emptyAccount(userId, now);
    },
    async recordTransaction(_input: RecordTransactionInput): Promise<CreditTransaction> {
      return unmetered("recordTransaction");
    },
    async topup(): Promise<CreditAccount> {
      return unmetered("topup");
    },
    async debit(): Promise<CreditAccount> {
      return unmetered("debit");
    },
    async reserveHold(): Promise<string> {
      return unmetered("reserveHold");
    },
    async settleHold(): Promise<CreditAccount> {
      return unmetered("settleHold");
    },
    async releaseHold(): Promise<CreditAccount> {
      return unmetered("releaseHold");
    },
    async getHold(): Promise<CreditHold | undefined> {
      return undefined;
    },
    async listTransactions(): Promise<CreditTransaction[]> {
      return [];
    },
  };
}
