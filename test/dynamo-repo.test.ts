/**
 * Runs the Auto repository contract against the AWS DynamoDB adapter.
 *
 * GATING: the whole suite is skipped unless DYNAMODB_ENDPOINT is set, so a plain
 * `npm test` on a machine without docker neither runs nor hangs. CI sets
 * DYNAMODB_ENDPOINT=http://127.0.0.1:8000 against a dynamodb-local service.
 *
 * Table + GSI key schemas (Phase A; the CDK stack in agentkitauto-infra mirrors):
 *   - AutoRuns       PK id            GSI userId-index (PK gsiUserId)
 *   - AutoApprovals  PK id            GSI userId-index (PK gsiUserId),
 *                                     GSI userKitKey-index (PK gsiUserKitKey)
 *   - AutoSchedules  PK id            GSI userId-index (PK gsiUserId),
 *                                     GSI dueIndex (PK gsiDue, SK nextRunAt)
 */

import { describe, it } from "vitest";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoAutoRunRepository,
  DynamoAutoApprovalRepository,
  DynamoAutoScheduleRepository,
  DynamoAutoWebhookRepository,
} from "../src/adapters/aws/index.js";
import { runRepositoryContract } from "./repository-contract.js";

const endpoint = process.env["DYNAMODB_ENDPOINT"];

if (!endpoint) {
  describe("Auto repository contract [dynamodb (skipped — set DYNAMODB_ENDPOINT)]", () => {
    it.skip("skipped: DYNAMODB_ENDPOINT not set", () => {});
  });
} else {
  const RUNS = "AutoRuns-test";
  const APPROVALS = "AutoApprovals-test";
  const SCHEDULES = "AutoSchedules-test";
  const WEBHOOKS = "AutoWebhooks-test";

  const raw = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });

  const runsTable: CreateTableCommandInput = {
    TableName: RUNS,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "gsiUserId", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [{ AttributeName: "gsiUserId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };

  const approvalsTable: CreateTableCommandInput = {
    TableName: APPROVALS,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "gsiUserId", AttributeType: "S" },
      { AttributeName: "gsiUserKitKey", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [{ AttributeName: "gsiUserId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "userKitKey-index",
        KeySchema: [{ AttributeName: "gsiUserKitKey", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };

  const schedulesTable: CreateTableCommandInput = {
    TableName: SCHEDULES,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "gsiUserId", AttributeType: "S" },
      { AttributeName: "gsiDue", AttributeType: "S" },
      { AttributeName: "nextRunAt", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [{ AttributeName: "gsiUserId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "dueIndex",
        KeySchema: [
          { AttributeName: "gsiDue", KeyType: "HASH" },
          { AttributeName: "nextRunAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };

  const webhooksTable: CreateTableCommandInput = {
    TableName: WEBHOOKS,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "gsiUserId", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [{ AttributeName: "gsiUserId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };

  const drop = async (name: string): Promise<void> => {
    const { TableNames } = await raw.send(new ListTablesCommand({}));
    if (TableNames?.includes(name)) await raw.send(new DeleteTableCommand({ TableName: name }));
  };

  runRepositoryContract("dynamodb (dynamodb-local)", async () => {
    const reset = async (): Promise<void> => {
      await drop(RUNS);
      await drop(APPROVALS);
      await drop(SCHEDULES);
      await drop(WEBHOOKS);
      await raw.send(new CreateTableCommand(runsTable));
      await raw.send(new CreateTableCommand(approvalsTable));
      await raw.send(new CreateTableCommand(schedulesTable));
      await raw.send(new CreateTableCommand(webhooksTable));
    };
    return {
      runs: new DynamoAutoRunRepository(db, RUNS),
      approvals: new DynamoAutoApprovalRepository(db, APPROVALS),
      schedules: new DynamoAutoScheduleRepository(db, SCHEDULES),
      webhooks: new DynamoAutoWebhookRepository(db, WEBHOOKS),
      reset,
    };
  });
}
