/**
 * Webhook secret helpers (Phase C): hash + constant-time verify.
 */

import { describe, expect, it } from "vitest";
import {
  generateWebhookSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
} from "../src/core/webhook-secret.js";

describe("webhook secret", () => {
  it("generates a URL-safe random secret of the requested entropy", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b); // overwhelmingly likely
    // base64url alphabet only (no +,/,=).
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes to a stable 64-char sha256 hex (never the plaintext)", () => {
    const secret = "s3cr3t-value";
    const h = hashWebhookSecret(secret);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(secret);
    // Deterministic.
    expect(hashWebhookSecret(secret)).toBe(h);
  });

  it("verifies a matching secret against its hash", () => {
    const secret = generateWebhookSecret();
    const hash = hashWebhookSecret(secret);
    expect(verifyWebhookSecret(secret, hash)).toBe(true);
  });

  it("rejects a mismatched secret (constant-time, no throw)", () => {
    const hash = hashWebhookSecret("correct");
    expect(verifyWebhookSecret("wrong", hash)).toBe(false);
    // A short/malformed stored hash never throws — it just fails.
    expect(verifyWebhookSecret("correct", "deadbeef")).toBe(false);
    expect(verifyWebhookSecret("correct", "")).toBe(false);
  });
});
