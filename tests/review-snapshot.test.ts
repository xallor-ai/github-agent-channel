import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openFetchedReviewSnapshot,
  openReviewSnapshot,
} from "../src/review-snapshot.js";

test("bare review views pin two commits, search unchanged callers and release independently", async (t) => {
  const tmp = mkdtempSync(
    join(realpathSync.native(tmpdir()), "channel-reviews-"),
  );
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const src = join(tmp, "work");
  const bare = join(tmp, "scope.git");
  mkdirSync(src);
  function git(...args: string[]) {
    return execFileSync("git", args, {
      cwd: src,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  }
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  writeFileSync(join(src, "impl.ts"), "first version\n");
  writeFileSync(
    join(src, "unchanged.ts"),
    "// usage example\nreturn use(impl);\n",
  );
  git("add", ".");
  git("commit", "-qm", "first");
  const h1 = git("rev-parse", "HEAD");
  writeFileSync(join(src, "impl.ts"), "second version\n");
  git("add", "impl.ts");
  // Git's portable plumbing creates symlink/submodule entries even on Windows.
  git(
    "update-index",
    "--add",
    "--cacheinfo",
    "120000",
    git("rev-parse", "HEAD:impl.ts"),
    "link",
  );
  git("update-index", "--add", "--cacheinfo", "160000", h1, "nested");
  git("commit", "-qm", "second");
  const h2 = git("rev-parse", "HEAD");
  git("clone", "-q", "--bare", "--no-local", src, bare);
  git(
    "--git-dir",
    bare,
    "config",
    "remote.origin.url",
    "https://github.com/acme/example.git",
  );
  const pins = { repositoryId: 7, fullName: "acme/example" };
  const repos = { "7": bare };
  const [first, second] = await Promise.all(
    [h1, h2].map((sha) => openReviewSnapshot(repos, { ...pins, sha })),
  );
  assert.equal((await first.read("impl.ts")).text, "first version\n");
  assert.equal((await second.read("impl.ts")).text, "second version\n");
  assert.deepEqual(await first.search("use(impl)"), {
    sha: h1,
    matches: [{ path: "unchanged.ts", line: 2, text: "return use(impl);" }],
    truncated: false,
  });
  assert.equal((await second.search("use(impl)")).truncated, true);
  for (const path of [
    "link",
    "nested",
    "../config",
    "/abs",
    ".git/config",
    "x\\..\\config",
    "HEAD:impl.ts",
  ])
    await assert.rejects(second.read(path), /regular file/);
  first.close();
  await assert.rejects(first.search("impl"), /closed/);
  assert.equal((await second.search("first version")).matches.length, 0);
  second.close();
  await assert.rejects(
    openReviewSnapshot(repos, { ...pins, sha: h1, fullName: "acme/wrong" }),
    /origin/,
  );
  await assert.rejects(
    openReviewSnapshot(repos, { ...pins, sha: h1, repositoryId: 8 }),
    /No review snapshot/,
  );
  await assert.rejects(
    openReviewSnapshot(repos, { ...pins, sha: "HEAD" }),
    /No review snapshot/,
  );
  await assert.rejects(
    openReviewSnapshot(repos, {
      ...pins,
      sha: git("rev-parse", "HEAD:impl.ts"),
    }),
    /commit/,
  );
  writeFileSync(join(bare, "objects", "info", "alternates"), src);
  await assert.rejects(
    openReviewSnapshot(repos, { ...pins, sha: h1 }),
    /redirection/,
  );
});

test("fetched views reject incomplete material, validate pin/path uniqueness and release text", async () => {
  const sha = "1".repeat(40);
  const payload = {
    sha,
    complete: true,
    files: [{ path: "test.ts", text: "alpha\nuse.impl();\n" }],
  };
  const view = openFetchedReviewSnapshot(payload, sha);
  assert.deepEqual(await view.search("use.impl("), {
    sha,
    truncated: false,
    matches: [{ path: "test.ts", line: 2, text: "use.impl();" }],
  });
  assert.equal((await view.search(".*")).matches.length, 0);
  assert.equal((await view.read("test.ts")).text, payload.files[0].text);
  await assert.rejects(view.read("../test.ts"), /regular file/);
  assert.throws(
    () => openFetchedReviewSnapshot({ ...payload, complete: false }, sha),
    /Invalid/,
  );
  assert.throws(
    () => openFetchedReviewSnapshot(payload, "2".repeat(40)),
    /version/,
  );
  assert.throws(
    () =>
      openFetchedReviewSnapshot(
        { ...payload, files: [...payload.files, ...payload.files] },
        sha,
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      openFetchedReviewSnapshot(
        { ...payload, files: [{ path: "../secret", text: "" }] },
        sha,
      ),
    /Invalid/,
  );
  view.close();
  await assert.rejects(view.read("test.ts"), /closed/);
});

test("search and read limits are visible and literal patterns cannot change the query mode", async () => {
  const sha = "f".repeat(40);
  const text = ("x".repeat(1000) + " [.*] end\n").repeat(80);
  const view = openFetchedReviewSnapshot(
    {
      sha,
      complete: true,
      files: [{ path: "large", text }],
    },
    sha,
  );
  const hits = await view.search("[.*]");
  assert.equal(hits.truncated, true);
  assert.equal(hits.matches.length, 50);
  assert.equal(hits.matches[49].line, 50);
  assert.match(hits.matches[49].text, /\[\.\*\]/);
  const file = await view.read("large");
  assert.equal(file.truncated, true);
  assert.ok(file.text.length < text.length);
  await assert.rejects(view.search("\n"), /literal/);
  view.close();
});
