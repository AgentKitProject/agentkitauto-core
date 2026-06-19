/**
 * Runs the Auto repository contract against the Postgres self-host adapter,
 * backed by pg-mem (in-memory Postgres) so no external services or Docker are
 * required. Mirrors gateway-core / market-core pg-mem tests.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { newDb } from "pg-mem";
import {
  PostgresAutoRunRepository,
  PostgresAutoApprovalRepository,
  PostgresAutoScheduleRepository,
  PostgresAutoWebhookRepository,
  type PgPool,
} from "../src/adapters/selfhost/postgres.js";
import { runRepositoryContract, type ContractRepos } from "./repository-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(
  join(here, "..", "src", "adapters", "selfhost", "schema.sql"),
  "utf8",
);

runRepositoryContract("postgres (pg-mem)", async () => {
  let repos: ContractRepos;

  const reset = async (): Promise<void> => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool() as unknown as PgPool;
    await pool.query(schemaSql);
    repos = {
      runs: new PostgresAutoRunRepository(pool),
      approvals: new PostgresAutoApprovalRepository(pool),
      schedules: new PostgresAutoScheduleRepository(pool),
      webhooks: new PostgresAutoWebhookRepository(pool),
      reset,
    };
  };

  await reset();

  return {
    get runs() {
      return repos.runs;
    },
    get approvals() {
      return repos.approvals;
    },
    get schedules() {
      return repos.schedules;
    },
    get webhooks() {
      return repos.webhooks;
    },
    reset,
  };
});
