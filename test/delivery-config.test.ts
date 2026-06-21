/**
 * validateDeliveryConfig (Phase D model validation): email basic-format,
 * webhook url MUST be https, both optional, absent → undefined.
 */

import { describe, expect, it } from "vitest";
import { validateDeliveryConfig, deliveryConfigSchema } from "../src/core/types.js";

describe("validateDeliveryConfig", () => {
  it("treats absent/null as no delivery", () => {
    expect(validateDeliveryConfig(undefined)).toBeUndefined();
    expect(validateDeliveryConfig(null)).toBeUndefined();
  });

  it("accepts a valid email + https webhook config", () => {
    const config = validateDeliveryConfig({
      email: ["a@example.com", "b@sub.example.org"],
      webhook: { url: "https://hooks.example.com/x", secret: "s" },
    });
    expect(config?.email).toEqual(["a@example.com", "b@sub.example.org"]);
    expect(config?.webhook?.url).toBe("https://hooks.example.com/x");
  });

  it("accepts an empty object (no channels)", () => {
    expect(validateDeliveryConfig({})).toEqual({});
  });

  it("rejects a malformed email address", () => {
    expect(() => validateDeliveryConfig({ email: ["not-an-email"] })).toThrow(/Invalid deliveryConfig/);
  });

  it("rejects a non-https webhook url", () => {
    expect(() => validateDeliveryConfig({ webhook: { url: "http://hooks.example.com/x" } })).toThrow(/https/i);
  });

  it("rejects unknown keys (strict schema)", () => {
    expect(() => validateDeliveryConfig({ slack: "#chan" } as never)).toThrow(/Invalid deliveryConfig/);
    expect(deliveryConfigSchema.safeParse({ slack: 1 }).success).toBe(false);
  });
});
