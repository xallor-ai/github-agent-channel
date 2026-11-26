import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task } from "../src/contracts.js";
import { createReviewCachePreparer } from "../src/review-cache.js";
import { openReviewSnapshot } from "../src/review-snapshot.js";
import { gitEnvironment } from "../src/runtime-workspace.js";

test("managed cache admits immutable pins and negotiates H2 from H1 without a second clone", async (t) => {
  const tmp = mkdtempSync(join(realpathSync.native(tmpdir()), "review-cache-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const src = join(tmp, "fixture"),
    root = join(tmp, "cache");
  mkdirSync(src);
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: gitEnvironment(),
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git(src, "init", "-q", "--template=");
  git(src, "config", "user.email", "fixture@example.test");
  git(src, "config", "user.name", "Fixture");
  writeFileSync(join(src, "unchanged"), randomBytes(512 * 1024));
  function commit(text: string) {
    writeFileSync(join(src, "caller"), text);
    git(src, "add", ".");
    git(src, "commit", "-qm", text);
    return git(src, "rev-parse", "HEAD");
  }
  const h1 = commit("first"),
    h2 = commit("second");
  const task = (sha: string) =>
    ({
      bindingId: "fixture",
      owner: "ORG",
      repo: "Example",
      repositoryId: 1,
      installationId: 3,
      target: {
        kind: "pull_request",
        number: 2,
        revision: { headSha: sha, baseSha: h1, headRepoId: 1, baseRepoId: 1 },
      },
    }) as Task;
  let grants = 0,
    fetches = 0;
  const grant = async () => {
    grants++;
    return {
      token: "fake",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  };
  const prepare = createReviewCachePreparer(async (dir, url, sha, token) => {
    assert.equal(url, "https://github.com/org/example.git");
    assert.equal(token, "fake");
    fetches++;
    git(
      dir,
      "-c",
      "fetch.unpackLimit=1",
      "--git-dir",
      dir,
      "fetch",
      "--quiet",
      "--no-auto-maintenance",
      "--no-tags",
      "--depth=1",
      "--no-write-fetch-head",
      pathToFileURL(src).href,
      sha + ":refs/heads/h" + sha,
    );
  });
  const dir = await prepare(root, task(h1), grant);
  const stale = join(root, ".preparing-abc123");
  mkdirSync(stale, { mode: 0o700 });
  writeFileSync(join(stale, "abandoned"), "interrupted download");
  assert.equal(await prepare(root, task(h1), grant), dir);
  assert.ok(!readdirSync(root).includes(".preparing-abc123"));
  assert.equal(grants, 1);
  assert.equal(fetches, 1);
  const packSizes = () =>
    readdirSync(join(dir, "objects/pack"))
      .filter((f) => f.endsWith(".pack"))
      .map((f) => statSync(join(dir, "objects/pack", f)).size);
  assert.ok(Math.max(...packSizes()) > 500000);
  const interrupted = createReviewCachePreparer(async (stage) => {
    writeFileSync(join(stage, "shallow.lock"), "incomplete update");
    throw Error("interrupted");
  });
  await assert.rejects(interrupted(root, task(h2), grant), /unavailable/);
  assert.equal(await prepare(root, task(h1), grant), dir);
  assert.equal(await prepare(root, task(h2), grant), dir);
  assert.ok(
    Math.min(...packSizes()) < 4096,
    "second pack should omit existing unchanged blob",
  );
  for (const [sha, text] of [
    [h1, "first"],
    [h2, "second"],
  ]) {
    const snap = await openReviewSnapshot(dir, {
      fullName: "org/example",
      sha,
    });
    assert.equal((await snap.read("caller")).text, text);
    snap.close();
  }
  await assert.rejects(
    prepare(root, { ...task(h1), repo: "wrong" }, grant),
    /origin/,
  );
  const badTask = task(h1);
  if (badTask.target.kind === "pull_request")
    badTask.target.revision!.headRepoId = 42;
  await assert.rejects(prepare(root, badTask, grant), /pin/);
  await assert.rejects(
    prepare(root, task(h2), grant, AbortSignal.abort()),
    /abort/i,
  );
  writeFileSync(
    join(dir, "config"),
    readFileSync(join(dir, "config"), "utf8") +
      "[credential]\n helper = unexpected\n",
  );
  await assert.rejects(
    prepare(root, task("a".repeat(40)), grant),
    /configuration/,
  );
  assert.equal(grants, 3);
  assert.equal(fetches, 2);
});

test("cold failure discards staging, redacts transport diagnostics, and rejects overlapping preparation", async (t) => {
  const tmp = mkdtempSync(
    join(realpathSync.native(tmpdir()), "review-failure-"),
  );
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, "cache");
  const sha = "a".repeat(40);
  const task = {
    bindingId: "x",
    owner: "org",
    repo: "example",
    repositoryId: 1,
    installationId: 2,
    target: {
      kind: "pull_request",
      number: 1,
      revision: { headSha: sha, baseSha: sha, headRepoId: 1, baseRepoId: 1 },
    },
  } as Task;
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const grant = async () => ({
    token: "do-not-log",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const prepare = createReviewCachePreparer(
    async (_dir, _url, _sha, token, signal) => {
      started.resolve();
      await new Promise<void>((done) =>
        signal.addEventListener("abort", () => done(), { once: true }),
      );
      throw Error(token);
    },
  );
  const pending = prepare(root, task, grant, controller.signal);
  await started.promise;
  await assert.rejects(prepare(root, task, grant), /busy/);
  controller.abort();
  await assert.rejects(
    pending,
    /^Error: Review cache Git operation unavailable$/,
  );
  assert.deepEqual(readdirSync(root), ["channel.lock"]);
});
