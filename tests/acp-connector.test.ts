import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { AcpConnector } from "../src/acp-connector.js";
import { runtimeEnvironment } from "../src/acp-connector.js";
import type { Task } from "../src/contracts.js";
import {
  collectChanges,
  inspectWorkspace,
  git as inspectGit,
  gitEnvironment,
} from "../src/runtime-workspace.js";
const peer = resolve("tests/fixtures/acp-peer.mjs");
const temporaryDirectories: string[] = [];
test("Git rejects runtime-written fsmonitor and clean filters without executing them", (t) => {
  process.env.CHANNEL_REVIEW_SENTINEL = "synthetic-bridge-secret";
  t.after(() => delete process.env.CHANNEL_REVIEW_SENTINEL);
  for (const kind of ["fsmonitor", "filter"]) {
    const f = fixture();
    const sha = f.git("rev-parse", "HEAD");
    const marker = join(f.dir, ".git", "captured");
    const script = join(f.dir, ".git", "capture.cjs");
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.env.CHANNEL_REVIEW_SENTINEL||'executed');`,
    );
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
    if (kind === "fsmonitor") f.git("config", "core.fsmonitor", command);
    else {
      writeFileSync(join(f.dir, ".gitattributes"), "file.txt filter=evil\n");
      f.git("config", "filter.evil.clean", command);
    }
    writeFileSync(join(f.dir, "file.txt"), "after");
    assert.throws(() => collectChanges(f.dir, sha), /configuration|helper/i);
    assert.equal(existsSync(marker), false);
  }
});
test("inspection ignores parent Git redirection and configuration variables", (t) => {
  const f = fixture();
  const sha = f.git("rev-parse", "HEAD");
  const names = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ];
  const prior = names.map((n) => process.env[n]);
  t.after(() =>
    names.forEach((n, i) => {
      if (prior[i] === undefined) delete process.env[n];
      else process.env[n] = prior[i];
    }),
  );
  process.env.GIT_DIR = join(f.dir, "missing");
  process.env.GIT_WORK_TREE = "invalid";
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.bare";
  process.env.GIT_CONFIG_VALUE_0 = "true";
  assert.equal(inspectGit(f.dir, "rev-parse", "HEAD"), sha);
  assert.equal(gitEnvironment().GIT_DIR, undefined);
  assert.equal(gitEnvironment().GIT_CONFIG_COUNT, undefined);
});
test("Git metadata cannot redirect through linked worktrees or alternates", () => {
  const f = fixture();
  writeFileSync(
    join(f.dir, ".git", "objects", "info", "alternates"),
    "/elsewhere/objects\n",
  );
  assert.throws(() => inspectWorkspace(f.dir, task), /metadata redirection/);
  const linked = fixture();
  renameSync(join(linked.dir, ".git"), join(linked.dir, "metadata"));
  writeFileSync(join(linked.dir, ".git"), "gitdir: metadata\n");
  assert.throws(() => inspectWorkspace(linked.dir, task), /linked worktrees/);
});
test("metadata mutation is rejected before collecting changes", () => {
  const f = fixture();
  const initial = inspectWorkspace(f.dir, task);
  f.git("config", "remote.origin.url", "https://github.com/elsewhere/repo.git");
  assert.throws(
    () => collectChanges(f.dir, initial.baseSha, initial.metadataHash),
    /metadata/,
  );
});

for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
  test(`${flag} cannot hide changes from workspace admission or collection`, async () => {
    const f = fixture();
    const initial = inspectWorkspace(f.dir, task);
    f.git("update-index", flag, "file.txt");
    // Reject the flag even before the hidden content differs.
    assert.throws(() => inspectWorkspace(f.dir, task), /index flags/i);
    writeFileSync(join(f.dir, "file.txt"), "hidden change");
    assert.throws(
      () => collectChanges(f.dir, initial.baseSha, initial.metadataHash),
      /index flags/i,
    );
    await assert.rejects(
      f.connector.run(task, async () => ({})),
      /index flags/i,
    );
    assert.equal(
      existsSync(join(f.dir, ".git", "received-prompt.json")),
      false,
    );
    assert.equal(
      readFileSync(join(f.dir, "file.txt"), "utf8"),
      "hidden change",
    );
  });

  test(`verification cannot hide an additional modified file using ${flag}`, async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "helper.txt"), "original helper");
    f.git("add", "helper.txt");
    f.git("commit", "-m", "helper");
    f.config.verification.args = [
      "-e",
      `require('node:child_process').execFileSync('git',['update-index','${flag}','helper.txt']);require('node:fs').writeFileSync('helper.txt','hidden verification change')`,
    ];
    await assert.rejects(
      f.connector.run(task, async () => ({})),
      /unknown/i,
    );
    assert.equal(
      readFileSync(join(f.dir, "helper.txt"), "utf8"),
      "hidden verification change",
    );
  });
}

test("push target mismatch rejects a clean workspace before harness launch", async () => {
  const f = fixture();
  const baseSha = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.dir, "file.txt"), "new revision");
  f.git("add", "file.txt");
  f.git("commit", "-m", "target");
  const targetSha = f.git("rev-parse", "HEAD");
  f.git("checkout", "--detach", baseSha);
  await assert.rejects(
    f.connector.run(
      {
        ...task,
        source: { event: "push" },
        target: {
          kind: "repository",
          ref: "refs/heads/feature",
          sha: targetSha,
        },
      },
      async () => {
        throw Error("Unexpected issue read");
      },
    ),
    /target SHA/i,
  );
  assert.equal(existsSync(join(f.dir, ".git", "received-prompt.json")), false);
  assert.equal(f.git("rev-parse", "HEAD"), baseSha);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("ACP refuses an unpinned, stale or cross-repository PR before dispatch", async () => {
  const f = fixture("permission");
  const sha = f.git("rev-parse", "HEAD");
  const pin = {
    headSha: sha,
    baseSha: "f".repeat(40),
    baseRepoId: 2,
    headRepoId: 2,
  };
  for (const revision of [
    undefined,
    { ...pin, headSha: pin.baseSha },
    { ...pin, baseRepoId: 3 },
    { ...pin, headRepoId: 3 },
  ]) {
    await assert.rejects(
      f.connector.run(
        { ...task, target: { kind: "pull_request", number: 1, revision } },
        async () => ({}),
      ),
      /pinned PR head/i,
    );
    assert.equal(
      existsSync(join(f.dir, ".git", "received-prompt.json")),
      false,
    );
    assert.equal(f.git("rev-parse", "HEAD"), sha);
  }
});
test("matching push SHA runs from its pinned detached workspace", async () => {
  const f = fixture();
  const sha = f.git("rev-parse", "HEAD");
  f.git("checkout", "--detach", sha);
  const result = await f.connector.run(
    {
      ...task,
      source: { event: "push" },
      target: {
        kind: "repository",
        ref: "refs/heads/feature",
        sha: sha.toUpperCase(),
      },
    },
    async () => {
      throw Error("Unexpected issue read");
    },
  );
  assert.equal(
    result.artifacts.find((a) => a.kind === "change_set")?.baseSha,
    sha,
  );
  assert.equal(result.publication.kind, "pull_request");
});
test("change bytes match the 512 KiB outcome boundary", () => {
  const f = fixture();
  const sha = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.dir, "file.txt"), "x".repeat(512 * 1024 + 1));
  assert.throws(() => collectChanges(f.dir, sha), /size limit/);
});

test("collected UTF-8 bytes preserve BOM and non-ASCII text", () => {
  const f = fixture();
  const sha = f.git("rev-parse", "HEAD");
  const bytes = Buffer.from("efbbbfe4bda0e5a5bd0a", "hex");
  writeFileSync(join(f.dir, "file.txt"), bytes);
  const files = collectChanges(f.dir, sha);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "file.txt");
  assert.deepEqual(Buffer.from(files[0].content!, "utf8"), bytes);
});

for (const [operation, mutation] of [
  ["rewrites a candidate", "fs.writeFileSync('file.txt','UNVERIFIED\\n')"],
  ["adds a publication input", "fs.writeFileSync('new.txt','UNVERIFIED\\n')"],
  ["deletes a candidate", "fs.unlinkSync('file.txt')"],
] as const) {
  test(`successful verification that ${operation} cannot publish`, async () => {
    const f = fixture();
    f.config.verification.args = [
      "-e",
      `const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('file.txt','utf8'),'after\\n');console.log('checked original candidate');${mutation}`,
    ];
    const result = await f.connector.run(task, async () => ({
      title: "Issue",
    }));
    const report = result.artifacts.find((a) => a.kind === "test_report");
    assert.equal(report?.exitCode, 0);
    assert.equal(result.publication.kind, "none");
    assert.match(report?.summary ?? "", /publication inputs changed/i);
    assert.ok(result.artifacts.some((a) => a.kind === "change_set"));
    assert.match(
      readFileSync(join(f.dir, ".git", "received-prompt.json"), "utf8"),
      /Issue/,
    );
  });
}
after(() => {
  for (const dir of temporaryDirectories) {
    const actual = realpathSync.native(dir);
    assert.equal(dirname(actual), realpathSync.native(tmpdir()));
    assert.ok(basename(actual).startsWith("acp-"));
    rmSync(actual, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});
function fixture(mode = "edit") {
  const dir = mkdtempSync(join(tmpdir(), "acp-"));
  temporaryDirectories.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init");
  git("config", "core.autocrlf", "false");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  git("remote", "add", "origin", "https://github.com/org/repo.git");
  writeFileSync(join(dir, "file.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "initial");
  const config: any = {
    type: "acp",
    command: process.execPath,
    args: [peer, mode],
    workspaces: { "2": dir },
    envRefs: {},
    permissionPolicy: "deny",
    timeoutMs: 30000,
    verification: {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10000,
    },
    publication: { kind: "pull_request", baseBranch: "main" },
  };
  return {
    dir,
    git,
    config,
    connector: new AcpConnector(config, resolve("agent.yaml")),
  };
}
const task: Task = {
  id: "test-task",
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  prompt: "edit file",
  target: { kind: "issue", number: 1 },
  source: { event: "issue_comment", action: "created", commentId: 5 },
  deliveryId: "delivery",
  bindingId: "binding",
  installationId: 1,
  actorId: 3,
  actorLogin: "actor",
  status: "running",
  deliveryStatus: "pending",
  error: null,
  createdAt: 1,
  outcome: null,
  runtime: null,
  publicationReceipt: null,
};
test("real ACP SDK peer edits workspace and produces observed change and verification artifacts", async (t) => {
  const f = fixture();
  process.env.CHANNEL_SECRET = "must-not-leak";
  t.after(() => delete process.env.CHANNEL_SECRET);
  const events: any[] = [];
  const result = await f.connector.run(
    task,
    async () => {},
    undefined,
    async (e) => {
      events.push(e);
    },
  );
  assert.equal(events[0].runId, "fixture-session");
  assert.equal(result.text, "Edited.");
  assert.equal(result.publication.kind, "pull_request");
  assert.equal(
    result.artifacts.find((a) => a.kind === "change_set")?.files[0].content,
    "after\n",
  );
  assert.equal(
    result.artifacts.find((a) => a.kind === "test_report")?.exitCode,
    0,
  );
});
test("dirty and wrong-origin workspaces rejected before agent launch", async () => {
  const f = fixture();
  writeFileSync(join(f.dir, "file.txt"), "dirty");
  await assert.rejects(
    f.connector.run(task, async () => {}),
    /clean/i,
  );
  f.git("checkout", "--", ".");
  f.git("remote", "set-url", "origin", "https://github.com/other/repo.git");
  await assert.rejects(
    f.connector.run(task, async () => {}),
    /origin/i,
  );
});
test("process interruption is ambiguous and never replayed", async () => {
  const f = fixture("crash");
  await assert.rejects(
    f.connector.run(task, async () => {}),
    /unknown|ambiguous/i,
  );
});
test("cancel after session start is ambiguous", async () => {
  const f = fixture("hang");
  const abort = new AbortController();
  await assert.rejects(
    f.connector.run(
      task,
      async () => {},
      abort.signal,
      async () => abort.abort(),
    ),
    /unknown|ambiguous/i,
  );
});
test("explicit env references do not inherit host secrets or execution hooks", () => {
  const env = runtimeEnvironment(
    { API_KEY: "MODEL_TOKEN" },
    {
      PATH: "bin",
      CHANNEL_TOKEN: "secret",
      ADMIN_TOKEN: "secret",
      NODE_OPTIONS: "danger",
      MODEL_TOKEN: "model",
    },
  );
  assert.deepEqual(env, { PATH: "bin", API_KEY: "model" });
  assert.throws(
    () => runtimeEnvironment({ API_KEY: "MISSING" }, {}),
    /Missing/,
  );
});
test("executable mode changes cannot silently become ordinary files", () => {
  const f = fixture();
  const sha = f.git("rev-parse", "HEAD");
  f.git("update-index", "--chmod=+x", "file.txt");
  assert.throws(() => collectChanges(f.dir, sha), /mode/i);
});
test("staged unsupported file types are rejected even when working file is unchanged", () => {
  const f = fixture();
  const sha = f.git("rev-parse", "HEAD");
  const blob = f.git("rev-parse", "HEAD:file.txt");
  const before = readFileSync(join(f.dir, "file.txt"), "utf8");
  f.git("update-index", "--cacheinfo", `120000,${blob},file.txt`);
  assert.match(f.git("diff", "--cached", "--raw", sha), /120000/);
  assert.equal(readFileSync(join(f.dir, "file.txt"), "utf8"), before);
  assert.throws(() => collectChanges(f.dir, sha), /mode/i);
});
test("failed verification is recorded, never replaced by model claims", async () => {
  const f = fixture();
  f.config.verification.args = ["-e", "process.exit(7)"];
  const result = await f.connector.run(task, async () => {});
  assert.equal(
    result.artifacts.find((a) => a.kind === "test_report")?.exitCode,
    7,
  );
  assert.equal(result.publication.kind, "none");
  assert.ok(result.artifacts.some((a) => a.kind === "change_set"));
});
test("oversized issue context is bounded and explicitly marked truncated", async () => {
  const f = fixture();
  await f.connector.run(task, async () => ({ body: "x".repeat(200000) }));
  const prompt = JSON.parse(
    readFileSync(join(f.dir, ".git", "received-prompt.json"), "utf8"),
  )[0].text;
  assert.ok(prompt.length < 100000);
  assert.match(prompt, /"truncated":true/);
});
test("ACP receives scoped issue context and observed verification evidence in PR body", async () => {
  const f = fixture();
  f.config.verification.args = ["-e", "console.log('observed-check-ok')"];
  const calls: any[] = [];
  const result = await f.connector.run(
    { ...task, prompt: "implement this issue" },
    async (name, args) => {
      calls.push([name, args]);
      return {
        title: "Scoped issue title",
        body: "Add the requested parser",
        number: 1,
      };
    },
  );
  assert.deepEqual(calls, [["read_issue", {}]]);
  const prompt = JSON.parse(
    readFileSync(join(f.dir, ".git", "received-prompt.json"), "utf8"),
  )[0].text;
  assert.match(prompt, /Scoped issue title/);
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /Do not commit or push/);
  assert.match(prompt, /"owner":"org"/);
  assert.match(prompt, /[a-f0-9]{40}/);
  assert.equal(result.publication.kind, "pull_request");
  if (result.publication.kind === "pull_request") {
    assert.match(result.publication.body, /exitCode=0/);
    assert.match(result.publication.body, /observed-check-ok/);
  }
});
test("authorization failure never prompts harness; repository targets skip issue reads", async () => {
  const f = fixture();
  let started = false;
  await assert.rejects(
    f.connector.run(
      task,
      async () => {
        throw Error("Unauthorized scoped issue");
      },
      undefined,
      async () => {
        started = true;
      },
    ),
    /Unauthorized/,
  );
  assert.equal(started, false);
  assert.equal(existsSync(join(f.dir, ".git", "received-prompt.json")), false);
  const repository = fixture();
  await repository.connector.run(
    { ...task, target: { kind: "repository" } },
    async () => {
      throw Error("must skip read_issue");
    },
  );
});
test("verification timeout records unknown exit and disables publication", async () => {
  const f = fixture();
  f.config.verification = {
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},10000)"],
    timeoutMs: 50,
  };
  const result = await f.connector.run(task, async () => ({ title: "issue" }));
  assert.equal(
    result.artifacts.find((a) => a.kind === "test_report")?.exitCode,
    null,
  );
  assert.equal(result.publication.kind, "none");
});
test("runtime credentials reach only harness, not verification or published output", async (t) => {
  const f = fixture("runtime-auth");
  const old = process.env.TEST_MODEL_AUTH;
  process.env.TEST_MODEL_AUTH = "synthetic-runtime-secret";
  t.after(() => {
    if (old === undefined) delete process.env.TEST_MODEL_AUTH;
    else process.env.TEST_MODEL_AUTH = old;
  });
  f.config.envRefs = { MODEL_API_KEY: "TEST_MODEL_AUTH" };
  f.config.verification.args = [
    "-e",
    "console.log(process.env.MODEL_API_KEY||'no-model-secret');console.log(process.env.TEST_MODEL_AUTH||'no-source-secret');process.exit(process.env.MODEL_API_KEY||process.env.TEST_MODEL_AUTH?9:0)",
  ];
  const result = await f.connector.run(task, async () => ({ title: "issue" }));
  const report = result.artifacts.find((a) => a.kind === "test_report");
  assert.equal(report?.exitCode, 0);
  assert.match(report?.summary ?? "", /no-model-secret/);
  assert.match(report?.summary ?? "", /no-source-secret/);
  assert.equal(result.publication.kind, "pull_request");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-runtime-secret/);
});
test("every ACP result explicitly declares artifacts and target-based publication", async () => {
  for (const kind of ["issue", "pull_request", "repository"] as const) {
    const f = fixture("permission");
    delete f.config.publication;
    delete f.config.verification;
    const sha = f.git("rev-parse", "HEAD");
    const target =
      kind === "repository"
        ? { kind }
        : kind === "pull_request"
          ? {
              kind,
              number: 1,
              revision: {
                headSha: sha,
                baseSha: "f".repeat(40),
                baseRepoId: 2,
                headRepoId: 2,
              },
            }
          : { kind, number: 1 };
    const result = await f.connector.run({ ...task, target }, async () => ({
      title: "issue",
    }));
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.publication, {
      kind: kind === "repository" ? "none" : "comment",
    });
  }
});
test("runtime cannot commit over the captured baseline", async () => {
  const f = fixture("commit");
  await assert.rejects(
    f.connector.run(task, async () => {}),
    /unknown/i,
  );
});
test("permission defaults deny; explicit allow-once selects only a one-shot option", async () => {
  for (const policy of ["deny", "allow-once"]) {
    const f = fixture("permission");
    f.config.permissionPolicy = policy;
    const result = await f.connector.run(task, async () => {});
    assert.equal(result.text, policy === "deny" ? "cancelled" : "once");
  }
});
