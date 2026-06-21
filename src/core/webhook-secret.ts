/**
 * Webhook secret helpers (Phase C).
 *
 * SECURITY MODEL: a webhook is authenticated by a shared secret. We persist ONLY
 * a sha256 hex HASH of that secret on the AutoWebhook — the plaintext is shown
 * to the user ONCE at creation (by the web layer) and never stored. Verification
 * is a CONSTANT-TIME compare of sha256(presented) against the stored hash, so a
 * mismatch length/value cannot be probed by timing.
 *
 * `generateWebhookSecret` is provided for convenience (and for tests), but the
 * web layer is expected to generate the actual random secret it shows the user;
 * core only requires the hash + verify to be deterministic + constant-time.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generates a random URL-safe webhook secret (the plaintext shown once). */
export function generateWebhookSecret(byteLength = 32): string {
  // base64url — compact, copy-pasteable, no padding.
  return randomBytes(byteLength).toString("base64url");
}

/** sha256 hex of a secret. This (not the plaintext) is what gets persisted. */
export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time check that `providedSecret` hashes to `expectedHash`. Hashing
 * first means the two compared buffers are always the same length (64 hex
 * chars), so timingSafeEqual never throws on a length mismatch and the compare
 * is genuinely constant-time across attacker-controlled input.
 */
export function verifyWebhookSecret(providedSecret: string, expectedHash: string): boolean {
  const provided = Buffer.from(hashWebhookSecret(providedSecret), "utf8");
  // A malformed/short stored hash would differ in length; pad-compare safely.
  const expected = Buffer.from(expectedHash, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
