import test from "node:test";
import assert from "node:assert/strict";
import { summarizeReviewInput } from "../src/review-input.js";

const revision = {
  baseRepoId: 11,
  headRepoId: 11,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const task = {
  repositoryId: 11,
  target: { kind: "pull_request" as const, number: 4, revision },
  source: { event: "pull_request", action: "synchronize" },
};
const entry = {
  path: "confidential/path",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-private detail\n+changed detail",
  patchStatus: "provided",
};
const data = {
  untrusted: true,
  revision,
  changedFiles: 4,
  files: [
    entry,
    { ...entry, path: "other", patchStatus: "truncated" },
    { ...entry, path: "binary", patch: undefined, patchStatus: "unavailable" },
  ],
  limitations: ["untrusted diagnostic"],
};
test("cloud audit distinguishes supplied file coverage from omissions and retains no paths, patches or diagnostic text", () => {
  assert.deepEqual(summarizeReviewInput(task, data), {
    revision,
    changedFiles: 4,
    suppliedFiles: 3,
    completePatches: 1,
    truncatedPatches: 1,
    unavailablePatches: 1,
    limited: true,
  });
  assert.deepEqual(
    summarizeReviewInput(task, {
      ...data,
      changedFiles: 0,
      files: [],
      limitations: [],
    }),
    {
      revision,
      changedFiles: 0,
      suppliedFiles: 0,
      completePatches: 0,
      truncatedPatches: 0,
      unavailablePatches: 0,
      limited: false,
    },
  );
  assert.equal(
    summarizeReviewInput(task, { ...data, changedFiles: 0, files: [] })
      ?.limited,
    true,
  );
});
test("wrong pins or duplicated file evidence cannot be recorded as input for this review", () => {
  for (const invalid of [
    { ...data, revision: { ...revision, baseSha: "c".repeat(40) } },
    { ...data, files: [entry, entry] },
    { ...data, changedFiles: 1 },
    { ...data, revision: { ...revision, headRepoId: 77 } },
  ])
    assert.throws(() => summarizeReviewInput(task, invalid));
  assert.equal(
    summarizeReviewInput(
      { ...task, source: { event: "issue_comment", action: "created" } },
      data,
    ),
    null,
  );
});
