// Real GitHub HTTPS + Git, using this job's read-only token, not a live Channel grant.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReviewCache } from "../dist/review-cache.js";

const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const repositoryId = Number(process.env.CACHE_PROBE_REPOSITORY_ID);
const token = process.env.CACHE_PROBE_TOKEN;
assert.ok(token && Number.isSafeInteger(repositoryId) && repositoryId > 0);
delete process.env.CACHE_PROBE_TOKEN;
const rev = (ref) =>
  execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
const h1 = rev("HEAD^");
const h2 = rev("HEAD");
const makeTask = (sha) => ({
  owner,
  repo,
  installationId: 1,
  repositoryId,
  bindingId: "ci-smoke",
  target: {
    kind: "pull_request",
    number: 1,
    revision: {
      baseSha: h1,
      headSha: sha,
      baseRepoId: repositoryId,
      headRepoId: repositoryId,
    },
  },
});
const tmp = await mkdtemp(join(tmpdir(), "channel-cache-smoke-"));
let grants = 0;
const grant = async () => {
  grants++;
  return { token, expiresAt: new Date(Date.now() + 300000).toISOString() };
};
try {
  const prepare = (sha) =>
    prepareReviewCache(join(tmp, "cache"), makeTask(sha), grant);
  const first = await prepare(h1);
  assert.equal(await prepare(h2), first);
  assert.equal(await prepare(h1), first);
  assert.equal(grants, 2);
  for (const sha of [h1, h2]) {
    const object = execFileSync(
      "git",
      ["--git-dir", first, "rev-parse", sha + ":README.md"],
      { encoding: "utf8" },
    ).trim();
    assert.equal(object, rev(sha + ":README.md"));
  }
  console.log(
    "Authenticated cold fetch, next revision and pinned cache reuse verified",
    h1,
    h2,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
