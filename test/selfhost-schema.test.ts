/**
 * Self-host schema + free-ledger tests.
 *
 *  - ensureAutoSchema creates the four Auto tables idempotently (pg-mem), and is
 *    memoised per pool.
 *  - The embedded AUTO_SCHEMA_SQL stays structurally in sync with schema.sql
 *    (same CREATE TABLE set) so the dist-shipped string can't drift from the file.
 *  - The self-host FREE credit ledger is inert on reads but throws on any spend
 *    path (a spend on a free deployment is a misconfiguration, not silent grant).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import {
  AUTO_SCHEMA_SQL,
  ensureAutoSchema,
  PostgresAutoRunRepository,
  type PgPool,
} from "../src/adapters/selfhost/postgres.js";
import { makeFreeCreditLedger } from "../src/adapters/selfhost/free-ledger.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSqlFile = readFileSync(
  join(here, "..", "src", "adapters", "selfhost", "schema.sql"),
  "utf8",
);

function newPool(): { pool: PgPool; queries: string[] } {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const real = new Pool() as unknown as PgPool;
  const queries: string[] = [];
  const pool: PgPool = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      return real.query(sql, params);
    },
  };
  return { pool, queries };
}

function tableNames(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
    .map((m) => m[1])
    .sort();
}

describe("ensureAutoSchema", () => {
  it("creates the four Auto tables and is idempotent + memoised per pool", async () => {
    const { pool, queries } = newPool();
    await ensureAutoSchema(pool);
    // Insert proves auto_runs (and its columns) exist after schema creation.
    const repo = new PostgresAutoRunRepository(pool);
    const run = await repo.createRun({
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      input: { prompt: "hi" },
      budgetCents: 100,
      model: "claude",
      createdAt: new Date().toISOString(),
    });
    expect(run.id).toBeTruthy();

    const schemaCalls = queries.filter((q) => q.includes("auto_runs")).length;
    const before = queries.length;
    await ensureAutoSchema(pool); // memoised — no new schema query
    expect(queries.length).toBe(before);
    expect(schemaCalls).toBeGreaterThan(0);
  });

  it("embedded AUTO_SCHEMA_SQL matches schema.sql's CREATE TABLE set", () => {
    expect(tableNames(AUTO_SCHEMA_SQL)).toEqual(tableNames(schemaSqlFile));
    expect(tableNames(AUTO_SCHEMA_SQL)).toEqual([
      "auto_approvals",
      "auto_runs",
      "auto_schedules",
      "auto_webhooks",
    ]);
  });
});

describe("makeFreeCreditLedger", () => {
  it("is inert on reads but throws on every spend path", async () => {
    const ledger = makeFreeCreditLedger();
    // Reads: safe inert values.
    await expect(ledger.getAccount("u1")).resolves.toBeUndefined();
    await expect(ledger.getHold("h1")).resolves.toBeUndefined();
    await expect(ledger.listTransactions("u1")).resolves.toEqual([]);
    const acct = await ledger.ensureAccount("u1", "2026-01-01T00:00:00Z");
    expect(acct.availableBalanceCents).toBe(0);

    // Spend paths: must throw (a free deployment never meters).
    await expect(ledger.reserveHold("u1", 10, "now")).rejects.toThrow(/FREE billing/);
    await expect(ledger.settleHold("h", 1, "now")).rejects.toThrow(/FREE billing/);
    await expect(ledger.debit("u1", 1, "now")).rejects.toThrow(/FREE billing/);
    await expect(ledger.topup("u1", 1, "now")).rejects.toThrow(/FREE billing/);
  });
});
