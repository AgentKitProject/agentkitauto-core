/**
 * Guarded HTTP egress (Phase C http_fetch). Fully offline: both fetch and the
 * DNS resolver are injected, so no real network / DNS is touched.
 *
 * Asserts: https-only, allowlist (exact + *.suffix), SSRF guard (private /
 * loopback / link-local / metadata via mocked resolver AND literal IPs), size
 * truncation + header subset.
 */

import { describe, expect, it, vi } from "vitest";
import {
  guardedHttpFetch,
  hostMatchesAllowlist,
  isBlockedIp,
  HttpFetchError,
  type DnsResolver,
  type FetchFn,
} from "../src/core/http-fetch.js";

/** A fetch stub that returns a fixed body + headers and records the call. */
function fakeFetch(
  body = "ok",
  status = 200,
  headerPairs: [string, string][] = [["content-type", "text/plain"], ["set-cookie", "secret"]],
): { fn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchFn = async (url) => {
    calls.push(url);
    return {
      status,
      headers: {
        forEach(cb: (value: string, key: string) => void) {
          for (const [k, v] of headerPairs) cb(v, k);
        },
      },
      async text() {
        return body;
      },
    };
  };
  return { fn, calls };
}

const publicResolver: DnsResolver = async () => ["93.184.216.34"]; // example.com public IP

describe("hostMatchesAllowlist", () => {
  it("matches exact hostnames case-insensitively", () => {
    expect(hostMatchesAllowlist("API.example.com", ["api.example.com"])).toBe(true);
    expect(hostMatchesAllowlist("api.example.com", ["other.com"])).toBe(false);
  });

  it("matches *.suffix subdomains but NOT the apex", () => {
    expect(hostMatchesAllowlist("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatchesAllowlist("deep.a.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatchesAllowlist("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatchesAllowlist("evilexample.com", ["*.example.com"])).toBe(false);
  });
});

describe("isBlockedIp (SSRF ranges)", () => {
  it("blocks private / loopback / link-local / metadata / unique-local", () => {
    for (const ip of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("blocks an unparseable address (fail closed)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("guardedHttpFetch", () => {
  const allowedHosts = ["api.example.com", "*.svc.example.com"];

  it("fetches an allowlisted https host that resolves public, returning a header subset", async () => {
    const { fn, calls } = fakeFetch("hello world");
    const res = await guardedHttpFetch(
      { url: "https://api.example.com/data" },
      { allowedHosts, fetchFn: fn, resolver: publicResolver },
    );
    expect(calls).toEqual(["https://api.example.com/data"]);
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe("hello world");
    // Only safelisted headers are surfaced (no set-cookie).
    expect(res.headers).toEqual({ "content-type": "text/plain" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("matches a *.suffix host", async () => {
    const { fn } = fakeFetch();
    const res = await guardedHttpFetch(
      { url: "https://a.svc.example.com/" },
      { allowedHosts, fetchFn: fn, resolver: publicResolver },
    );
    expect(res.status).toBe(200);
  });

  it("rejects a non-allowlisted host (never calls fetch)", async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      guardedHttpFetch(
        { url: "https://evil.com/" },
        { allowedHosts, fetchFn: fn, resolver: publicResolver },
      ),
    ).rejects.toBeInstanceOf(HttpFetchError);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-https schemes", async () => {
    const { fn, calls } = fakeFetch();
    await expect(
      guardedHttpFetch(
        { url: "http://api.example.com/" },
        { allowedHosts, fetchFn: fn, resolver: publicResolver },
      ),
    ).rejects.toThrow(/https/i);
    expect(calls).toHaveLength(0);
  });

  it("SSRF: rejects when DNS resolves to a private/metadata IP (rebinding defense)", async () => {
    const { fn, calls } = fakeFetch();
    const rebind: DnsResolver = async () => ["169.254.169.254"];
    await expect(
      guardedHttpFetch(
        { url: "https://api.example.com/" },
        { allowedHosts, fetchFn: fn, resolver: rebind },
      ),
    ).rejects.toThrow(/blocked address/i);
    expect(calls).toHaveLength(0);
  });

  it("SSRF: rejects when ANY resolved IP is private (mixed answer)", async () => {
    const { fn } = fakeFetch();
    const mixed: DnsResolver = async () => ["93.184.216.34", "10.0.0.5"];
    await expect(
      guardedHttpFetch(
        { url: "https://api.example.com/" },
        { allowedHosts, fetchFn: fn, resolver: mixed },
      ),
    ).rejects.toThrow(/blocked address/i);
  });

  it("SSRF: rejects a literal private-IP URL without resolving", async () => {
    const { fn } = fakeFetch();
    const resolver = vi.fn<DnsResolver>(async () => ["1.2.3.4"]);
    // The literal IP must itself be allowlisted to reach the SSRF check.
    await expect(
      guardedHttpFetch(
        { url: "https://127.0.0.1/" },
        { allowedHosts: ["127.0.0.1"], fetchFn: fn, resolver },
      ),
    ).rejects.toThrow(/blocked/i);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("truncates the body to the size cap", async () => {
    const big = "x".repeat(1000);
    const { fn } = fakeFetch(big);
    const res = await guardedHttpFetch(
      { url: "https://api.example.com/" },
      { allowedHosts, fetchFn: fn, resolver: publicResolver, maxResponseBytes: 100 },
    );
    expect(res.truncated).toBe(true);
    expect(res.bodyText).toHaveLength(100);
  });
});
