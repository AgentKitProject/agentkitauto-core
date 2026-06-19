/**
 * Local-disk WorkspaceStore — the shared, path-confined filesystem
 * implementation used by BOTH adapters in Phase A:
 *   - aws/      → a per-run prefix under an OS tmp dir (S3-backed workspaces are
 *                 deferred; see the AWS adapter note + README).
 *   - selfhost/ → a per-run dir on a k8s PersistentVolume.
 *
 * SECURITY: every caller-supplied path is canonicalized and confined to the
 * workspace root. We reject:
 *   - absolute paths,
 *   - traversal that escapes the root (`..`),
 *   - symlinks whose real target escapes the root.
 * The confinement is enforced with a realpath + startsWith check on the parent
 * directory, so a symlink planted inside the workspace cannot be used to read or
 * write outside it.
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { WorkspaceStore } from "./ports.js";
import type { WorkspaceFileEntry } from "./types.js";

export interface FsWorkspaceStoreOptions {
  /** The root directory under which each run's workspace lives. */
  rootDir: string;
}

/** Thrown when a path escapes its workspace. Surfaced as an error result. */
export class WorkspaceEscapeError extends Error {
  readonly name = "WorkspaceEscapeError";
}

export class FsWorkspaceStore implements WorkspaceStore {
  constructor(private readonly opts: FsWorkspaceStoreOptions) {}

  private workspaceRoot(workspaceId: string): string {
    // workspaceId is opaque + server-generated; still guard against separators.
    if (workspaceId.includes("/") || workspaceId.includes("\\") || workspaceId.includes("..")) {
      throw new WorkspaceEscapeError(`Invalid workspace id: ${workspaceId}`);
    }
    return nodePath.join(this.opts.rootDir, workspaceId);
  }

  /**
   * Resolves a caller path inside the workspace, rejecting any escape. Returns
   * the absolute on-disk path. For existing targets, the real (symlink-resolved)
   * path of the deepest existing ancestor must also remain within the root.
   */
  private async resolveConfined(workspaceId: string, rel: string): Promise<string> {
    const root = this.workspaceRoot(workspaceId);
    if (nodePath.isAbsolute(rel)) {
      throw new WorkspaceEscapeError(`Absolute paths are not allowed: ${rel}`);
    }
    const joined = nodePath.resolve(root, rel);
    const lexicalRoot = nodePath.resolve(root);
    // Lexical confinement (against the lexical root, before any symlink resolve).
    if (joined !== lexicalRoot && !joined.startsWith(lexicalRoot + nodePath.sep)) {
      throw new WorkspaceEscapeError(`Path escapes the workspace: ${rel}`);
    }
    // Symlink confinement: compare the REAL paths so a symlinked root dir (e.g.
    // macOS /var → /private/var) doesn't cause false escapes. The real target
    // (or its deepest existing ancestor) must stay within the real root.
    const rootResolved = await fs.realpath(lexicalRoot);
    let probe = joined;
    // Walk up until we hit a path that exists on disk.
    // (The target itself may not exist yet for write_file.)
    // Limit iterations to the path depth.
    for (let i = 0; i < 4096; i++) {
      try {
        const real = await fs.realpath(probe);
        if (real !== rootResolved && !real.startsWith(rootResolved + nodePath.sep)) {
          throw new WorkspaceEscapeError(`Path resolves outside the workspace via symlink: ${rel}`);
        }
        break;
      } catch (err) {
        if (err instanceof WorkspaceEscapeError) throw err;
        const parent = nodePath.dirname(probe);
        if (parent === probe) break; // reached filesystem root
        probe = parent;
      }
    }
    return joined;
  }

  async createWorkspace(runId: string): Promise<string> {
    // Derive a filesystem-safe id from the run id plus randomness.
    const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const workspaceId = `ws-${safe}-${Math.random().toString(36).slice(2, 10)}`;
    await fs.mkdir(this.workspaceRoot(workspaceId), { recursive: true });
    return workspaceId;
  }

  async readFile(workspaceId: string, path: string): Promise<string> {
    const abs = await this.resolveConfined(workspaceId, path);
    return fs.readFile(abs, "utf8");
  }

  async listDir(workspaceId: string, path: string): Promise<string[]> {
    const abs = await this.resolveConfined(workspaceId, path);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  async writeFile(workspaceId: string, path: string, content: string): Promise<void> {
    const abs = await this.resolveConfined(workspaceId, path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async bundleResult(workspaceId: string): Promise<WorkspaceFileEntry[]> {
    const root = this.workspaceRoot(workspaceId);
    const out: WorkspaceFileEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = nodePath.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
        } else if (e.isFile()) {
          const stat = await fs.stat(abs);
          out.push({ path: nodePath.relative(root, abs), sizeBytes: stat.size });
        }
      }
    };
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async cleanup(workspaceId: string): Promise<void> {
    await fs.rm(this.workspaceRoot(workspaceId), { recursive: true, force: true });
  }
}
