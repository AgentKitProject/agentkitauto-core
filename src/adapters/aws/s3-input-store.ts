/**
 * S3-backed InputStore for the AWS adapter (Phase C user inputs).
 *
 * Staging model: the WEB layer uploads input bytes to S3 directly (presigned
 * PUT) under a per-run prefix `auto-inputs/{runId}/...` and records the manifest
 * on the run. So `stageInputs` here is a manifest builder (it computes the
 * canonical S3 key per file; it does NOT upload bytes — that already happened or
 * happens via a presigned URL the web layer issues). Hydration GETs each object
 * and writes it into the workspace `inputs/` subdir via the WorkspaceStore,
 * which is path-confined.
 */

import {
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type {
  InputStore,
  StagedInputFile,
  WorkspaceStore,
} from "../../core/ports.js";
import type { AutoRunInputFileRef } from "../../core/types.js";
import { confineInputPath, INPUTS_SUBDIR } from "../../core/input-store.js";

/** Builds the canonical S3 object key for a run's input file. */
export function inputObjectKey(runId: string, confinedPath: string): string {
  // confinedPath is `inputs/<...>`; strip the leading subdir for the key tail.
  const tail = confinedPath.startsWith(`${INPUTS_SUBDIR}/`)
    ? confinedPath.slice(INPUTS_SUBDIR.length + 1)
    : confinedPath;
  return `auto-inputs/${runId}/${tail}`;
}

export interface S3InputStoreOptions {
  client: S3Client;
  /** The packages/inputs bucket. */
  bucket: string;
}

export class S3InputStore implements InputStore {
  constructor(private readonly opts: S3InputStoreOptions) {}

  async stageInputs(runId: string, files: StagedInputFile[]): Promise<AutoRunInputFileRef[]> {
    // The web layer uploads bytes via presigned PUT; here we just compute the
    // canonical manifest (confined workspace path + the backing S3 key).
    return files.map((f) => {
      const confined = confineInputPath(f.path);
      return { path: confined, s3Key: f.s3Key ?? inputObjectKey(runId, confined) };
    });
  }

  async hydrateInputsIntoWorkspace(
    runId: string,
    workspace: WorkspaceStore,
    workspaceId: string,
    manifest: AutoRunInputFileRef[],
  ): Promise<string[]> {
    const written: string[] = [];
    for (const ref of manifest) {
      const confined = confineInputPath(ref.path);
      const key = ref.s3Key ?? inputObjectKey(runId, confined);
      const res = await this.opts.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      const body = res.Body;
      if (!body) continue;
      // AWS SDK v3 stream → string. transformToString is available on the
      // SdkStream in Node.
      const content = await (body as { transformToString(): Promise<string> }).transformToString();
      await workspace.writeFile(workspaceId, confined, content);
      written.push(confined);
    }
    return written;
  }
}
