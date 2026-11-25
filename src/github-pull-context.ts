import { z } from "zod";
import type { Octokit } from "@octokit/core";
import { AccessDenied, type PullRevision, type Task } from "./contracts.js";

function pullParams(task: Task) {
  if (
    task.target.kind !== "pull_request" ||
    !Number.isSafeInteger(task.target.number) ||
    task.target.number < 1
  )
    throw new AccessDenied("Task has no pull request scope");
  return {
    owner: task.owner,
    repo: task.repo,
    pull_number: task.target.number,
  };
}

export async function checkPull(
  client: Octokit,
  task: Task,
  resolving = false,
) {
  const params = pullParams(task);
  const expected = task.target.kind === "pull_request" && task.target.revision;
  if (!expected && (!resolving || task.source.event !== "issue_comment"))
    throw new AccessDenied("Missing target pull request revision");
  const { data } = await client.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    params,
  );
  if (
    data.number !== params.pull_number ||
    data.state !== "open" ||
    data.merged !== false
  )
    throw new AccessDenied("Target pull request is not confirmed open");
  // The installation credential is scoped to one repository. Even a visible
  // fork SHA is not evidence that this binding grants access to its contents.
  if (
    data.base?.repo?.id !== task.repositoryId ||
    data.head?.repo?.id !== task.repositoryId
  )
    throw new AccessDenied("Pull request repository is outside the binding");
  if (
    ![data.base.sha, data.head.sha].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    )
  )
    throw new AccessDenied("Invalid pull request revision");
  const revision: PullRevision = {
    baseSha: data.base.sha,
    headSha: data.head.sha,
    baseRepoId: data.base.repo.id,
    headRepoId: data.head.repo.id,
  };
  if (
    expected &&
    (expected.baseSha !== revision.baseSha ||
      expected.headSha !== revision.headSha ||
      expected.baseRepoId !== revision.baseRepoId ||
      expected.headRepoId !== revision.headRepoId)
  )
    throw new AccessDenied("Target pull request revision changed");
  return { revision, changedFiles: data.changed_files };
}

const MAX_FILES = 100;
const MAX_COMPARE_BYTES = 4 * 1024 * 1024;
const compareSchema = z.object({
  base_commit: z.object({ sha: z.string() }),
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        previous_filename: z.string().optional(),
        status: z.string().min(1),
        additions: z.number().int().nonnegative().safe(),
        deletions: z.number().int().nonnegative().safe(),
        patch: z.string().optional(),
      }),
    )
    .max(300),
});

// Compare paginates commits, not files: all available file entries are on the
// first page. Bound the upstream bytes before parsing its potentially large patches.
async function readComparison(body: unknown) {
  if (!(body instanceof ReadableStream))
    throw Error("Invalid compare response");
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw Error("Invalid compare response");
      bytes += value.byteLength;
      if (bytes > MAX_COMPARE_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return compareSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
    ),
  );
}
const MAX_FILE_JSON_BYTES = 64 * 1024;
const MAX_PATCH_CHARS = 12 * 1024;

interface FileEvidence {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patchStatus: "provided" | "truncated" | "unavailable";
}

export async function collectPullDiff(
  client: Octokit,
  task: Task,
  initial: Awaited<ReturnType<typeof checkPull>>,
  recheck: () => Promise<void>,
) {
  const { owner, repo } = pullParams(task);
  const { revision, changedFiles } = initial;
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0)
    throw new AccessDenied("Cannot confirm changed file count");
  const limitations = new Set<string>();
  const files: FileEvidence[] = [];
  const seen = new Set<string>();
  let remaining = MAX_FILE_JSON_BYTES;
  const response = await client.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner,
      repo,
      basehead: `${revision.baseSha}...${revision.headSha}`,
      page: 1,
      per_page: 1,
      request: { parseSuccessResponseBody: false, redirect: "error" },
    },
  );
  const comparison = await readComparison(response.data);
  await recheck();
  if (
    comparison &&
    (comparison.base_commit.sha !== revision.baseSha ||
      comparison.files.length > changedFiles)
  )
    throw Error("Inconsistent pinned comparison");
  if (!comparison)
    limitations.add(
      "Pinned comparison exceeds response byte limit; no file evidence supplied",
    );
  for (const item of (comparison?.files ?? []).slice(0, MAX_FILES)) {
    if (seen.has(item.filename)) throw Error("Duplicate PR file evidence");
    seen.add(item.filename);
    const entry: FileEvidence = {
      path: item.filename,
      status: item.status,
      ...(item.previous_filename
        ? { previousPath: item.previous_filename }
        : {}),
      additions: item.additions,
      deletions: item.deletions,
      patchStatus: "unavailable",
    };
    if (typeof item.patch === "string" && item.patch.length) {
      entry.patch = item.patch.slice(0, MAX_PATCH_CHARS);
      const lines = entry.patch.split("\n");
      entry.patchStatus =
        entry.patch.length !== item.patch.length ||
        lines.filter((line) => line.startsWith("+")).length !==
          item.additions ||
        lines.filter((line) => line.startsWith("-")).length !== item.deletions
          ? "truncated"
          : "provided";
    }
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (size > remaining) {
      limitations.add("File evidence reached the byte limit");
      break;
    }
    if (entry.patchStatus !== "provided")
      limitations.add("One or more patches are unavailable or incomplete");
    remaining -= size;
    files.push(entry);
  }
  if (files.length < changedFiles)
    limitations.add("Changed file list is incomplete");
  return {
    untrusted: true,
    revision,
    changedFiles,
    files,
    limitations: [...limitations],
  };
}
