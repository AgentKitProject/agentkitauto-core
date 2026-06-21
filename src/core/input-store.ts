/**
 * InputStore implementations (Phase C — out-of-band per-run input files).
 *
 * Two backends mirror the storage adapters:
 *   - LocalInputStore: keeps staged bytes in memory / on the local disk map
 *     (self-host / MinIO-equivalent for tests). Hydrates by writing each file
 *     into the workspace `inputs/` subdir through the WorkspaceStore.
 *   - (S3InputStore lives in adapters/aws — staged in S3 under a per-run prefix.)
 *
 * Hydration ALWAYS goes through the WorkspaceStore.writeFile path, which is
 * path-confined (traversal / absolute / symlink escape rejected). We additionally
 * confine each input under the `inputs/` subdir and reject any path that escapes
 * it, so a malicious manifest path cannot land outside `inputs/`.
 */

import type { InputStore, StagedInputFile, WorkspaceStore } from "./ports.js";
import type { AutoRunInputFileRef } from "./types.js";

/** The fixed subdir every staged input is hydrated into. */
export const INPUTS_SUBDIR = "inputs";

/** Thrown when a manifest path would escape the inputs/ subdir. */
export class InputPathError extends Error {
  readonly name = "InputPathError";
}

/**
 * Validates + normalizes a manifest path to a workspace-relative path under
 * `inputs/`. Rejects absolute paths and any `..` traversal. Returns the
 * workspace-relative path (e.g. `inputs/data/foo.csv`).
 *
 * IDEMPOTENT: an already-confined path (one whose first segment is the
 * `inputs/` subdir) is normalized in place rather than double-prefixed, so a
 * manifest carrying `inputs/...` paths round-trips through stage → hydrate.
 */
export function confineInputPath(rawPath: string): string {
  if (rawPath.length === 0) {
    throw new InputPathError("Input file path must be non-empty.");
  }
  // Normalize separators; reject absolute (posix or windows) paths.
  const p = rawPath.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) {
    throw new InputPathError(`Input file path must be relative: ${rawPath}`);
  }
  // Reject any traversal segment.
  let segments = p.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new InputPathError(`Input file path must not traverse upward: ${rawPath}`);
  }
  // Strip a leading `inputs/` so re-confining an already-confined path is a
  // no-op (the bucket + S3 keys use the canonical single-prefix form).
  if (segments[0] === INPUTS_SUBDIR) {
    segments = segments.slice(1);
  }
  if (segments.length === 0) {
    throw new InputPathError(`Input file path resolves to no file: ${rawPath}`);
  }
  return `${INPUTS_SUBDIR}/${segments.join("/")}`;
}

/**
 * A reusable, in-memory/local InputStore. Backing bytes are held per-run in a
 * map keyed by the manifest path. `stageInputs` requires inline `content` (the
 * self-host / local path); the AWS adapter overrides hydration to pull from S3.
 */
export class LocalInputStore implements InputStore {
  /** runId → (workspace-relative inputs/ path → UTF-8 content). */
  private readonly staged = new Map<string, Map<string, string>>();

  async stageInputs(runId: string, files: StagedInputFile[]): Promise<AutoRunInputFileRef[]> {
    const bucket = this.staged.get(runId) ?? new Map<string, string>();
    const manifest: AutoRunInputFileRef[] = [];
    for (const f of files) {
      const confined = confineInputPath(f.path);
      if (typeof f.content !== "string") {
        throw new InputPathError(
          `LocalInputStore.stageInputs requires inline "content" for ${f.path}.`,
        );
      }
      bucket.set(confined, f.content);
      manifest.push({ path: confined, ...(f.s3Key ? { s3Key: f.s3Key } : {}) });
    }
    this.staged.set(runId, bucket);
    return manifest;
  }

  async hydrateInputsIntoWorkspace(
    runId: string,
    workspace: WorkspaceStore,
    workspaceId: string,
    manifest: AutoRunInputFileRef[],
  ): Promise<string[]> {
    const bucket = this.staged.get(runId) ?? new Map<string, string>();
    const written: string[] = [];
    for (const ref of manifest) {
      // Re-confine on the way out (defense in depth — manifest is data).
      const confined = confineInputPath(ref.path);
      const content = bucket.get(confined);
      if (content === undefined) continue; // not staged (or staged elsewhere)
      // WorkspaceStore.writeFile is itself path-confined.
      await workspace.writeFile(workspaceId, confined, content);
      written.push(confined);
    }
    return written;
  }
}
