/**
 * The non-interactive, policy-gated sandbox executor — Auto's "hands".
 *
 * This is the key difference between Auto and the interactive gateway loop:
 * there is NO per-call human confirm dialog. The standing approval's
 * toolAllowlist IS the consent. Every call is gated by:
 *
 *     resolvedTools ∩ approval.toolAllowlist ∩ {read_file, list_dir, write_file}
 *
 * and every path is workspace-confined by the WorkspaceStore. `run_command` and
 * any network tool are HARD-REJECTED (returned as an error result, never an
 * autonomous shell). Errors are returned as `{ error }` results — they never
 * throw out of the loop, so one bad tool can't abort the whole run.
 *
 * The returned function matches the gateway-core / forge-core `ExecuteTool`
 * contract: `(toolUse) => Promise<{ result? } | { error? }>`.
 */

import type { AutoApproval } from "./types.js";
import type { AutoRunRepository, WorkspaceStore } from "./ports.js";

/** A tool_use request, matching the gateway-core wire shape. */
export interface SandboxToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** The ExecuteTool result shape (gateway-core / forge-core compatible). */
export type SandboxToolResult = { result?: unknown } | { error: string };

export type SandboxExecutor = (toolUse: SandboxToolUse) => Promise<SandboxToolResult>;

/** The only tools Phase A supports. There is NO run_command. */
export const SANDBOX_TOOLS = ["read_file", "list_dir", "write_file"] as const;
export type SandboxToolName = (typeof SANDBOX_TOOLS)[number];

export interface MakeSandboxExecutorArgs {
  workspace: WorkspaceStore;
  /** The workspace this run operates in (created by the worker). */
  workspaceId: string;
  runId: string;
  approval: AutoApproval;
  /** The repo to append every call to the run's audit log. */
  repo: AutoRunRepository;
  /**
   * The kit's resolved declared tools. A call is permitted only if its tool is
   * in (resolvedTools ∩ approval.toolAllowlist ∩ SANDBOX_TOOLS). If omitted, the
   * kit-tools gate is skipped (approval + sandbox set still apply).
   */
  resolvedTools?: string[];
  /** Clock — ISO 8601. Injected for deterministic tests. */
  now: () => string;
}

function summarizeArgs(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const path = (input as { path?: unknown }).path;
    if (typeof path === "string") return `path=${path}`;
  }
  return name;
}

/**
 * Builds the per-run executor. Every invocation is audited (ok / error /
 * rejected). The function never throws — it always resolves to a result/error
 * envelope so the driving tool-loop stays alive.
 */
export function makeSandboxExecutor(args: MakeSandboxExecutorArgs): SandboxExecutor {
  const { workspace, workspaceId, runId, approval, repo, resolvedTools, now } = args;
  const allowlist = new Set(approval.toolAllowlist);
  const kitTools = resolvedTools ? new Set(resolvedTools) : undefined;

  const reject = async (name: string, input: unknown, reason: string): Promise<SandboxToolResult> => {
    await repo.appendAudit(runId, {
      tool: name,
      argsSummary: summarizeArgs(name, input),
      outcome: "rejected",
      ts: now(),
      detail: reason,
    });
    return { error: reason };
  };

  const fail = async (name: string, input: unknown, message: string): Promise<SandboxToolResult> => {
    await repo.appendAudit(runId, {
      tool: name,
      argsSummary: summarizeArgs(name, input),
      outcome: "error",
      ts: now(),
      detail: message,
    });
    return { error: message };
  };

  const ok = async (name: string, input: unknown, result: unknown): Promise<SandboxToolResult> => {
    await repo.appendAudit(runId, {
      tool: name,
      argsSummary: summarizeArgs(name, input),
      outcome: "ok",
      ts: now(),
    });
    return { result };
  };

  return async (toolUse: SandboxToolUse): Promise<SandboxToolResult> => {
    const { name, input } = toolUse;

    // Gate 1: must be a supported sandbox tool. run_command / network → reject.
    if (!(SANDBOX_TOOLS as readonly string[]).includes(name)) {
      return reject(
        name,
        input,
        `Tool "${name}" is not permitted for autonomous runs (Phase A supports only ${SANDBOX_TOOLS.join(", ")}; no shell, no network).`,
      );
    }

    // Gate 2: must be in the standing approval's allowlist.
    if (!allowlist.has(name)) {
      return reject(name, input, `Tool "${name}" is not in the standing approval allowlist.`);
    }

    // Gate 3: must be one of the kit's declared tools (if provided).
    if (kitTools && !kitTools.has(name)) {
      return reject(name, input, `Tool "${name}" is not declared by the kit.`);
    }

    // Validate args shape (all sandbox tools require a string path).
    const path = (input as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== "string" || path.length === 0) {
      return fail(name, input, `Tool "${name}" requires a non-empty "path" argument.`);
    }

    // Dispatch — every workspace op is path-confined inside the WorkspaceStore.
    try {
      switch (name as SandboxToolName) {
        case "read_file": {
          const content = await workspace.readFile(workspaceId, path);
          return ok(name, input, content);
        }
        case "list_dir": {
          const entries = await workspace.listDir(workspaceId, path);
          return ok(name, input, entries);
        }
        case "write_file": {
          const content = (input as { content?: unknown }).content;
          if (typeof content !== "string") {
            return fail(name, input, `write_file requires a string "content" argument.`);
          }
          await workspace.writeFile(workspaceId, path, content);
          return ok(name, input, { written: path, bytes: Buffer.byteLength(content, "utf8") });
        }
        default:
          return reject(name, input, `Unsupported tool "${name}".`);
      }
    } catch (err) {
      // Path-escape / IO failures surface as error results, never as throws.
      return fail(name, input, err instanceof Error ? err.message : String(err));
    }
  };
}
