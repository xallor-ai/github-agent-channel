import { z } from "zod";
import { revisionSchema } from "./outcomes.js";
import { isAutomaticReview, type Task } from "./contracts.js";

const diffSchema = z.strictObject({
  untrusted: z.literal(true),
  revision: revisionSchema,
  changedFiles: z.number().int().nonnegative().safe(),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        previousPath: z.string().optional(),
        status: z.string(),
        additions: z.number().int().nonnegative().safe(),
        deletions: z.number().int().nonnegative().safe(),
        patch: z.string().optional(),
        patchStatus: z.enum(["unavailable", "truncated", "provided"]),
      }),
    )
    .max(100),
  limitations: z.array(z.string().max(256)).max(16),
});
export type ReviewDiff = z.infer<typeof diffSchema>;
type Scope = Pick<Task, "target" | "repositoryId" | "source">;

// Both sides verify the same assignment pin and payload budget. A successful
// cloud projection describes the input prepared, not a verdict or proof of receipt.
export function parseReviewInput(
  task: Pick<Scope, "target" | "repositoryId">,
  output: unknown,
): ReviewDiff {
  const parsed = diffSchema.safeParse(output);
  const pin = task.target.kind === "pull_request" && task.target.revision;
  if (!parsed.success) throw Error("Invalid PR diff context");
  const data = parsed.data,
    actual = data.revision;
  if (
    !pin ||
    pin.baseRepoId !== task.repositoryId ||
    pin.headRepoId !== task.repositoryId ||
    actual.baseRepoId !== pin.baseRepoId ||
    actual.headRepoId !== pin.headRepoId ||
    actual.baseSha !== pin.baseSha ||
    actual.headSha !== pin.headSha ||
    data.files.length > data.changedFiles ||
    Buffer.byteLength(JSON.stringify(data)) > 80 * 1024 ||
    new Set(data.files.map((f) => f.path)).size !== data.files.length
  )
    throw Error("PR diff does not match the assigned revision or limits");
  return data;
}
export function summarizeReviewInput(task: Scope, output: unknown) {
  if (!isAutomaticReview(task)) return null;
  const { revision, changedFiles, files, limitations } = parseReviewInput(
    task,
    output,
  );
  let completePatches = 0,
    truncatedPatches = 0;
  for (const file of files) {
    if (file.patchStatus === "truncated") truncatedPatches++;
    else if (
      file.patchStatus === "provided" &&
      file.patch &&
      /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(file.patch)
    )
      completePatches++;
  }
  return {
    revision,
    changedFiles,
    suppliedFiles: files.length,
    completePatches,
    truncatedPatches,
    unavailablePatches: files.length - completePatches - truncatedPatches,
    limited: limitations.length > 0 || completePatches !== changedFiles,
  };
}
export type ReviewInputSummary = NonNullable<
  ReturnType<typeof summarizeReviewInput>
>;
