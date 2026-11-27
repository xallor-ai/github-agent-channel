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
import { openReviewSnapshot } from "../src/review-snapshot.js";

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
  const pins = { fullName: "acme/example" };
  const [first, second] = await Promise.all(
    [h1, h2].map((sha) => openReviewSnapshot(bare, { ...pins, sha })),
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
    openReviewSnapshot(bare, { ...pins, sha: h1, fullName: "acme/wrong" }),
    /origin/,
  );
  await assert.rejects(
    openReviewSnapshot(bare, { ...pins, sha: "HEAD" }),
    /No review snapshot/,
  );
  await assert.rejects(
    openReviewSnapshot(bare, {
      ...pins,
      sha: git("rev-parse", "HEAD:impl.ts"),
    }),
    /commit/,
  );
  writeFileSync(join(bare, "objects", "info", "alternates"), src);
  await assert.rejects(
    openReviewSnapshot(bare, { ...pins, sha: h1 }),
    /redirection/,
  );
});
