/**
 * Sandbox executor: the non-interactive, policy-gated hands.
 *
 * Asserts:
 *   - workspace confinement (traversal / absolute / symlink escape rejected) via
 *     the REAL FsWorkspaceStore;
 *   - allowlist enforcement (tool not in approval allowlist → rejected);
 *   - kit-tools intersection (tool not declared by kit → rejected);
 *   - run_command + network tools hard-rejected (never an autonomous shell);
 *   - every call is appended to the run audit log with the right outcome.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSandboxExecutor } from "../src/core/sandbox-executor.js";
import { FsWorkspaceStore } from "../src/core/fs-workspace.js";
import type { AutoApproval } from "../src/core/types.js";
import { InMemoryRunRepo, noopNow } from "./fakes.js";

const approval: AutoApproval = {
  id: "appr-1",
  userId: "u1",
  kitRef: { source: "local", localKitId: "k1" },
  scope: "workspace_read_write",
  toolAllowlist: ["read_file", "list_dir", "write_file"],
  networkPolicy: { mode: "deny_all" },
  maxBudgetCents: 1000,
  createdAt: noopNow(),
  revokedAt: null,
};

describe("makeSandboxExecutor", () => {
  let rootDir: string;
  let store: FsWorkspaceStore;
  let workspaceId: string;
  let repo: InMemoryRunRepo;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "auto-sbx-"));
    store = new FsWorkspaceStore({ rootDir });
    workspaceId = await store.createWorkspace("run-1");
    repo = new InMemoryRunRepo();
    repo.seed({
      id: "run-1",
      userId: "u1",
      kitRef: { source: "local", localKitId: "k1" },
      status: "running",
      input: { prompt: "x" },
      budgetCents: 1000,
      spentCents: 0,
      model: "claude-sonnet-4-6",
      createdAt: noopNow(),
      auditLog: [],
    });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const makeExec = (resolvedTools = ["read_file", "list_dir", "write_file"]) =>
    makeSandboxExecutor({
      workspace: store,
      workspaceId,
      runId: "run-1",
      approval,
      repo,
      resolvedTools,
      now: noopNow,
    });

  it("writes then reads a file inside the workspace and audits ok", async () => {
    const exec = makeExec();
    const w = await exec({ toolUseId: "1", name: "write_file", input: { path: "out.txt", content: "hi" } });
    expect("result" in w).toBe(true);
    const r = await exec({ toolUseId: "2", name: "read_file", input: { path: "out.txt" } });
    expect((r as { result: unknown }).result).toBe("hi");
    const run = await repo.getRun("run-1");
    expect(run?.auditLog.map((e) => e.outcome)).toEqual(["ok", "ok"]);
  });

  it("rejects path traversal that escapes the workspace", async () => {
    const exec = makeExec();
    const res = await exec({ toolUseId: "1", name: "read_file", input: { path: "../../etc/passwd" } });
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/escape|outside|workspace/i);
    const run = await repo.getRun("run-1");
    expect(run?.auditLog[0]?.outcome).toBe("error");
  });

  it("rejects absolute paths", async () => {
    const exec = makeExec();
    const res = await exec({ toolUseId: "1", name: "read_file", input: { path: "/etc/hosts" } });
    expect("error" in res).toBe(true);
  });

  it("rejects a symlink whose target escapes the workspace", async () => {
    // Plant a symlink inside the workspace pointing at the OS root.
    const wsRoot = nodePath.join(rootDir, workspaceId);
    await fs.symlink("/etc", nodePath.join(wsRoot, "escape"));
    const exec = makeExec();
    const res = await exec({ toolUseId: "1", name: "read_file", input: { path: "escape/hosts" } });
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/symlink|outside|workspace/i);
  });

  it("hard-rejects run_command (no autonomous shell)", async () => {
    const exec = makeExec(["read_file", "run_command"]);
    const res = await exec({ toolUseId: "1", name: "run_command", input: { command: "rm -rf /" } });
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/not permitted|no shell/i);
    const run = await repo.getRun("run-1");
    expect(run?.auditLog[0]?.outcome).toBe("rejected");
  });

  it("rejects a network tool", async () => {
    const exec = makeExec(["read_file", "http_get"]);
    const res = await exec({ toolUseId: "1", name: "http_get", input: { url: "http://x" } });
    expect("error" in res).toBe(true);
  });

  it("rejects a tool not in the approval allowlist", async () => {
    const narrowed: AutoApproval = { ...approval, toolAllowlist: ["read_file"] };
    const exec = makeSandboxExecutor({
      workspace: store,
      workspaceId,
      runId: "run-1",
      approval: narrowed,
      repo,
      resolvedTools: ["read_file", "write_file"],
      now: noopNow,
    });
    const res = await exec({ toolUseId: "1", name: "write_file", input: { path: "a.txt", content: "x" } });
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/allowlist/i);
  });

  it("rejects a tool not declared by the kit", async () => {
    const exec = makeExec(["read_file"]); // write_file allowed by approval but not by kit
    const res = await exec({ toolUseId: "1", name: "write_file", input: { path: "a.txt", content: "x" } });
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/not declared/i);
  });

  // ---- http_fetch (Phase C network egress) ------------------------------
  describe("http_fetch", () => {
    const allowlistApproval: AutoApproval = {
      ...approval,
      toolAllowlist: ["read_file", "http_fetch"],
      networkPolicy: { mode: "allowlist", hosts: ["api.example.com"] },
    };
    const publicResolver = async (): Promise<string[]> => ["93.184.216.34"];
    const okFetch = async (): Promise<{
      status: number;
      headers: { forEach(cb: (v: string, k: string) => void): void };
      text(): Promise<string>;
    }> => ({
      status: 200,
      headers: { forEach: (cb) => cb("application/json", "content-type") },
      text: async () => `{"ok":true}`,
    });

    const makeNetExec = (appr: AutoApproval, withNetwork = true) =>
      makeSandboxExecutor({
        workspace: store,
        workspaceId,
        runId: "run-1",
        approval: appr,
        repo,
        resolvedTools: ["read_file", "http_fetch"],
        now: noopNow,
        ...(withNetwork ? { network: { fetchFn: okFetch, resolver: publicResolver } } : {}),
      });

    it("fetches an allowlisted host and audits ok", async () => {
      const exec = makeNetExec(allowlistApproval);
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "https://api.example.com/x" } });
      expect("result" in res).toBe(true);
      expect((res as { result: { status: number } }).result.status).toBe(200);
      const run = await repo.getRun("run-1");
      const entry = run?.auditLog[0];
      expect(entry?.outcome).toBe("ok");
      expect(entry?.tool).toBe("http_fetch");
      // Audit summarizes host/url, never the body.
      expect(entry?.argsSummary).toContain("host=api.example.com");
    });

    it("rejects a non-allowlisted host (audited rejected)", async () => {
      const exec = makeNetExec(allowlistApproval);
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "https://evil.com/" } });
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toMatch(/allowlist/i);
      const run = await repo.getRun("run-1");
      expect(run?.auditLog[0]?.outcome).toBe("rejected");
    });

    it("rejects a non-https url", async () => {
      const exec = makeNetExec(allowlistApproval);
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "http://api.example.com/" } });
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toMatch(/https/i);
    });

    it("rejects when the host resolves to a private IP (SSRF)", async () => {
      const exec = makeSandboxExecutor({
        workspace: store,
        workspaceId,
        runId: "run-1",
        approval: allowlistApproval,
        repo,
        resolvedTools: ["read_file", "http_fetch"],
        now: noopNow,
        network: { fetchFn: okFetch, resolver: async () => ["169.254.169.254"] },
      });
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "https://api.example.com/" } });
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toMatch(/blocked address/i);
    });

    it("is unavailable when http_fetch is not opted into the approval allowlist", async () => {
      // allowlist policy, but http_fetch NOT in the approval toolAllowlist.
      const noOptIn: AutoApproval = {
        ...approval,
        toolAllowlist: ["read_file"],
        networkPolicy: { mode: "allowlist", hosts: ["api.example.com"] },
      };
      const exec = makeNetExec(noOptIn);
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "https://api.example.com/" } });
      expect("error" in res).toBe(true);
      // Rejected at the approval-allowlist gate.
      expect((res as { error: string }).error).toMatch(/allowlist|unavailable/i);
    });

    it("is unavailable under a deny_all policy even if http_fetch is approved", async () => {
      const denyApproval: AutoApproval = {
        ...approval,
        toolAllowlist: ["read_file", "http_fetch"],
        networkPolicy: { mode: "deny_all" },
      };
      const exec = makeNetExec(denyApproval);
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "https://api.example.com/" } });
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toMatch(/deny_all|unavailable/i);
    });

    it("is unavailable when no network deps are injected (default-deny)", async () => {
      const exec = makeNetExec(allowlistApproval, /* withNetwork */ false);
      const res = await exec({ toolUseId: "1", name: "http_fetch", input: { url: "https://api.example.com/" } });
      expect("error" in res).toBe(true);
    });
  });
});
