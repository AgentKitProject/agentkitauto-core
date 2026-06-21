/**
 * Guarded HTTP egress for the sandbox `http_fetch` tool (Phase C).
 *
 * This is the autonomous-network security surface, so it is conservative and
 * default-deny:
 *   (a) https ONLY — http (and any other scheme) is rejected;
 *   (b) the host must match the approval's allowlist (exact hostname or
 *       `*.suffix` wildcard-suffix);
 *   (c) SSRF guard — the host is resolved to IPs and every resolved IP must be a
 *       PUBLIC address. Private (10/8, 172.16/12, 192.168/16), loopback (127/8,
 *       ::1), link-local / cloud-metadata (169.254/16 incl. 169.254.169.254),
 *       and unique-local IPv6 (fc00::/7) addresses are rejected. Literal-IP URLs
 *       in those ranges are rejected without a DNS lookup;
 *   (d) response size + timeout caps.
 *
 * Both `fetch` and the DNS resolver are INJECTED so tests are fully offline and
 * deterministic (no real network, no real DNS).
 */

import { isIP } from "node:net";

/** Resolves a hostname to a list of IP address strings (A + AAAA). Injected. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** A subset of the WHATWG fetch signature — injected for testability. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

export interface HttpFetchArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpFetchResult {
  status: number;
  /** A safe subset of response headers (lowercased keys). */
  headers: Record<string, string>;
  /** Response body, truncated to maxResponseBytes. */
  bodyText: string;
  /** True when the body was truncated by the size cap. */
  truncated: boolean;
}

export interface HttpFetchOptions {
  /** Allowlisted hosts (exact hostnames or `*.suffix` wildcard suffixes). */
  allowedHosts: string[];
  fetchFn: FetchFn;
  resolver: DnsResolver;
  /** Max response body bytes captured. Default 256 KiB. */
  maxResponseBytes?: number;
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

/** Thrown for any guard failure. The executor maps this to an error result. */
export class HttpFetchError extends Error {
  readonly name = "HttpFetchError";
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Allowlist match: exact hostname (case-insensitive) or `*.suffix` wildcard. */
export function hostMatchesAllowlist(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowed) {
    const pat = raw.toLowerCase();
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1); // ".example.com"
      // Matches a subdomain of example.com, but NOT the apex example.com.
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === pat) {
      return true;
    }
  }
  return false;
}

/**
 * SSRF guard: returns true if `ip` is a private / loopback / link-local /
 * unique-local / metadata address that egress must NEVER reach.
 */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  // Unparseable → block (fail closed).
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + metadata
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  // Unique-local fc00::/7 (fc00.. / fd00..).
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Link-local fe80::/10.
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  // IPv4-mapped (::ffff:127.0.0.1 etc.) — extract the v4 tail and re-check.
  const v4mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped && v4mapped[1]) return isBlockedIpv4(v4mapped[1]);
  return false;
}

/** A small safelist of response headers to surface (never the full set). */
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "date",
  "etag",
  "last-modified",
  "cache-control",
]);

/**
 * Perform a guarded fetch. Throws HttpFetchError on any guard failure
 * (non-https / non-allowlisted host / SSRF-blocked IP / unresolvable host).
 * Caller (sandbox executor) converts the throw into an error result + audit.
 */
export async function guardedHttpFetch(
  args: HttpFetchArgs,
  opts: HttpFetchOptions,
): Promise<HttpFetchResult> {
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // (a) Parse + https only.
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    throw new HttpFetchError(`Invalid URL: ${args.url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new HttpFetchError(`Only https is permitted (got ${parsed.protocol}).`);
  }

  // URL.hostname keeps the surrounding brackets for IPv6 literals (e.g. "[::1]"),
  // which makes isIP()/isBlockedIp() miss them — a SSRF bypass. Strip the brackets
  // so a literal IPv6 host is checked as the bare IP.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");

  // (b) Allowlist check.
  if (!hostMatchesAllowlist(host, opts.allowedHosts)) {
    throw new HttpFetchError(`Host "${host}" is not in the network allowlist.`);
  }

  // (c) SSRF guard. A literal-IP host is checked directly; a name is resolved
  // and EVERY resolved IP must be public (reject if any is private/loopback/
  // link-local/metadata, which defeats DNS-rebinding to an internal address).
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new HttpFetchError(`Host IP "${host}" is in a blocked (private/loopback/link-local) range.`);
    }
  } else {
    let ips: string[];
    try {
      ips = await opts.resolver(host);
    } catch (err) {
      throw new HttpFetchError(`Could not resolve host "${host}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ips.length === 0) {
      throw new HttpFetchError(`Host "${host}" did not resolve to any address.`);
    }
    for (const ip of ips) {
      if (isBlockedIp(ip)) {
        throw new HttpFetchError(`Host "${host}" resolves to a blocked address (${ip}).`);
      }
    }
  }

  // (d) Size + timeout caps.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = (args.method ?? "GET").toUpperCase();
    const res = await opts.fetchFn(args.url, {
      method,
      ...(args.headers ? { headers: args.headers } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      signal: controller.signal,
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (SAFE_RESPONSE_HEADERS.has(k)) headers[k] = value;
    });

    const full = await res.text();
    const truncated = Buffer.byteLength(full, "utf8") > maxBytes;
    const bodyText = truncated ? Buffer.from(full, "utf8").subarray(0, maxBytes).toString("utf8") : full;

    return { status: res.status, headers, bodyText, truncated };
  } finally {
    clearTimeout(timer);
  }
}
