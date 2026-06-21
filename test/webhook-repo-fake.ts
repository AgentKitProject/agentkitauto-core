/** In-memory AutoWebhookRepository for consumeWebhook + contract tests. */

import { randomUUID } from "node:crypto";
import type { AutoWebhookRepository } from "../src/core/ports.js";
import type {
  AutoWebhook,
  CreateWebhookInput,
  WebhookFireResult,
} from "../src/core/types.js";

export class InMemoryWebhookRepo implements AutoWebhookRepository {
  webhooks = new Map<string, AutoWebhook>();

  seed(webhook: AutoWebhook): AutoWebhook {
    this.webhooks.set(webhook.id, webhook);
    return webhook;
  }

  async createWebhook(input: CreateWebhookInput): Promise<AutoWebhook> {
    const webhook: AutoWebhook = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      approvalId: input.approvalId,
      budgetCents: input.budgetCents,
      model: input.model,
      ...(input.inferenceMode !== undefined ? { inferenceMode: input.inferenceMode } : {}),
      enabled: input.enabled ?? true,
      secretHash: input.secretHash,
      createdAt: input.createdAt,
      lastFiredAt: null,
      lastRunId: null,
      lastError: null,
      fireCount: 0,
    };
    this.webhooks.set(webhook.id, webhook);
    return structuredClone(webhook);
  }

  async getWebhook(webhookId: string): Promise<AutoWebhook | undefined> {
    const w = this.webhooks.get(webhookId);
    return w ? structuredClone(w) : undefined;
  }

  async listWebhooksByUser(userId: string): Promise<AutoWebhook[]> {
    return [...this.webhooks.values()]
      .filter((w) => w.userId === userId)
      .map((w) => structuredClone(w));
  }

  async recordFire(webhookId: string, result: WebhookFireResult): Promise<void> {
    const w = this.webhooks.get(webhookId);
    if (!w) return;
    w.lastFiredAt = result.lastFiredAt;
    w.lastRunId = result.lastRunId;
    w.lastError = result.lastError;
    w.fireCount += 1;
  }

  async setEnabled(webhookId: string, enabled: boolean): Promise<AutoWebhook | undefined> {
    const w = this.webhooks.get(webhookId);
    if (!w) return undefined;
    w.enabled = enabled;
    return structuredClone(w);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    this.webhooks.delete(webhookId);
  }
}
