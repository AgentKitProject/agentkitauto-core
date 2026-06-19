/**
 * User-provided inputs (Phase C): staging + workspace hydration, path-confinement
 * (traversal/absolute rejected), and a manifest round-trip. Uses the real
 * FsWorkspaceStore so the on-disk confinement is exercised end to end.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confineInputPath,
  INPUTS_SUBDIR,
  InputPathError,
  LocalInputStore,
} from "../src/core/input-store.js";
import { FsWorkspaceStore } from "../src/core/fs-workspace.js";

describe("confineInputPath", () => {
  it("places a relative path under inputs/", () => {
    expect(confineInputPath("data/foo.csv")).toBe(`${INPUTS_SUBDIR}/data/foo.csv`);
    expect(confineInputPath("./a.txt")).toBe(`${INPUTS_SUBDIR}/a.txt`);
  });

  it("rejects traversal, absolute, and empty paths", () => {
    expect(() => confineInputPath("../escape.txt")).toThrow(InputPathError);
    expect(() => confineInputPath("a/../../b.txt")).toThrow(InputPathError);
    expect(() => confineInputPath("/etc/passwd")).toThrow(InputPathError);
    expect(() => confineInputPath("C:/win.txt")).toThrow(InputPathError);
    expect(() => confineInputPath("")).toThrow(InputPathError);
  });
});

describe("LocalInputStore", () => {
  let rootDir: string;
  let workspace: FsWorkspaceStore;
  let workspaceId: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "auto-inputs-"));
    workspace = new FsWorkspaceStore({ rootDir });
    workspaceId = await workspace.createWorkspace("run-1");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("stages inline content and round-trips the manifest", async () => {
    const store = new LocalInputStore();
    const manifest = await store.stageInputs("run-1", [
      { path: "data/a.csv", content: "1,2,3" },
      { path: "b.txt", content: "hello" },
    ]);
    expect(manifest.map((m) => m.path)).toEqual([
      `${INPUTS_SUBDIR}/data/a.csv`,
      `${INPUTS_SUBDIR}/b.txt`,
    ]);
  });

  it("hydrates staged files into the workspace inputs/ subdir", async () => {
    const store = new LocalInputStore();
    const manifest = await store.stageInputs("run-1", [
      { path: "data/a.csv", content: "1,2,3" },
      { path: "b.txt", content: "hello" },
    ]);
    const written = await store.hydrateInputsIntoWorkspace("run-1", workspace, workspaceId, manifest);
    expect(written).toEqual([`${INPUTS_SUBDIR}/data/a.csv`, `${INPUTS_SUBDIR}/b.txt`]);

    // Files actually landed inside the workspace, confined to inputs/.
    expect(await workspace.readFile(workspaceId, `${INPUTS_SUBDIR}/data/a.csv`)).toBe("1,2,3");
    expect(await workspace.readFile(workspaceId, `${INPUTS_SUBDIR}/b.txt`)).toBe("hello");
  });

  it("rejects a malicious manifest path that escapes inputs/", async () => {
    const store = new LocalInputStore();
    await expect(
      store.hydrateInputsIntoWorkspace("run-1", workspace, workspaceId, [
        { path: "../../etc/passwd" },
      ]),
    ).rejects.toBeInstanceOf(InputPathError);
  });

  it("requires inline content for the local store", async () => {
    const store = new LocalInputStore();
    await expect(store.stageInputs("run-1", [{ path: "x.txt" }])).rejects.toBeInstanceOf(
      InputPathError,
    );
  });

  it("skips manifest entries that were never staged (best-effort hydration)", async () => {
    const store = new LocalInputStore();
    await store.stageInputs("run-1", [{ path: "present.txt", content: "yes" }]);
    const written = await store.hydrateInputsIntoWorkspace("run-1", workspace, workspaceId, [
      { path: "present.txt" },
      { path: "absent.txt" }, // valid path, never staged → skipped
    ]);
    expect(written).toEqual([`${INPUTS_SUBDIR}/present.txt`]);
  });
});
