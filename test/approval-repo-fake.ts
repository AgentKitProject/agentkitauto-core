/** In-memory AutoApprovalRepository for worker/approval-gate tests. */

import { randomUUID } from "node:crypto";
import type { AutoApprovalRepository } from "../src/core/ports.js";
import type { AutoApproval, CreateApprovalInput, KitRef } from "../src/core/types.js";
import { kitRefKey, normalizeNetworkPolicy } from "../src/core/types.js";

export class InMemoryApprovalRepo implements AutoApprovalRepository {
  approvals = new Map<string, AutoApproval>();

  async createApproval(input: CreateApprovalInput): Promise<AutoApproval> {
    const approval: AutoApproval = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      scope: input.scope ?? "workspace_read_write",
      toolAllowlist: input.toolAllowlist,
      networkPolicy: normalizeNetworkPolicy(input.networkPolicy),
      maxBudgetCents: input.maxBudgetCents,
      createdAt: input.createdAt,
      revokedAt: null,
    };
    this.approvals.set(approval.id, approval);
    return structuredClone(approval);
  }

  async getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined> {
    const key = `${userId}#${kitRefKey(kitRef)}`;
    const match = [...this.approvals.values()].find(
      (a) => `${a.userId}#${kitRefKey(a.kitRef)}` === key && a.revokedAt === null,
    );
    return match ? structuredClone(match) : undefined;
  }

  async listApprovalsByUser(userId: string): Promise<AutoApproval[]> {
    return [...this.approvals.values()]
      .filter((a) => a.userId === userId)
      .map((a) => structuredClone(a));
  }

  async revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined> {
    const a = this.approvals.get(approvalId);
    if (!a) return undefined;
    a.revokedAt = revokedAt;
    return structuredClone(a);
  }
}
