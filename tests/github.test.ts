import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { OctokitGitHubClient } from "../src/github.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type ChannelConfig,
  type Task,
} from "../src/contracts.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  github: { appId: "123", botLogin: "helper[bot]" },
  bindings: [
    {
      id: "b",
      installationId: 1,
      repositoryId: 2,
      owner: "org",
      repo: "repo",
      enabled: true,
    },
  ],
} as unknown as ChannelConfig & {
  bindings: import("../src/contracts.js").Binding[];
};
const task = {
  id: "task-1",
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "reader",
  target: { kind: "issue", number: 5 },
  source: { event: "issue_comment", action: "created", commentId: 10 },
} as Task;
const revision = {
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  baseRepoId: 2,
  headRepoId: 2,
};
const openPull = {
  state: "open",
  merged: false,
  number: 5,
  changed_files: 1,
  base: { sha: revision.baseSha, repo: { id: 2 } },
  head: { sha: revision.headSha, repo: { id: 2 } },
};
const pinned: Task = {
  ...task,
  target: { kind: "pull_request", number: 5, revision },
};
function fixture(
  options: {
    permission?: string;
    repoId?: number;
    deepReview?: boolean;
    grant?: () => unknown;
    failWrite?: boolean;
    writeStatus?: number;
    failRead?: boolean;
    revokeOnSecondCheck?: boolean;
    bindingEnabled?: () => boolean;
    pull?: () => { state: string; merged?: boolean } | null;
    files?: () => unknown[];
    fileAt?: (ref: string | null) => string;
    gitObject?: (path: string) => unknown;
    comments?: unknown[];
    issueState?: "open" | "closed";
    directory?: boolean;
    contentStatus?: number;
    size?: number;
  } = {},
) {
  const calls: { path: string; method: string; body: any }[] = [];
  let authChecks = 0;
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    let data: unknown;
    if (url.pathname === "/app/installations/1/access_tokens")
      data =
        !body.permissions.pull_requests && options.grant
          ? options.grant()
          : {
              token: "fake-installation-token",
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              permissions: body.permissions,
              repository_selection: "selected",
              repositories: [{ id: 2 }],
            };
    else if (url.pathname === "/repos/org/repo") {
      if (options.failRead) throw new Error("network failed");
      data = { id: options.repoId ?? 2, name: "repo", owner: { login: "org" } };
    } else if (url.pathname.endsWith("/collaborators/reader/permission")) {
      authChecks++;
      data = {
        permission:
          options.revokeOnSecondCheck && authChecks > 1
            ? "read"
            : (options.permission ?? "write"),
        user: { id: 3, login: "reader" },
      };
    } else if (url.pathname === "/repos/org/repo/pulls/5") {
      const pull = options.pull ? options.pull() : openPull;
      if (pull === null) return new Response("{}", { status: 404 });
      data = pull;
    } else if (url.pathname.includes("/git/")) {
      data = options.gitObject?.(url.pathname);
    } else if (
      url.pathname ===
      `/repos/org/repo/compare/${revision.baseSha}...${revision.headSha}`
    ) {
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("per_page"), "1");
      data = {
        base_commit: { sha: revision.baseSha },
        files: options.files?.() ?? [],
      };
    } else if (url.pathname.endsWith("/comments") && method === "POST") {
      if (options.failWrite || options.writeStatus)
        return new Response("{}", { status: options.writeStatus ?? 502 });
      data = {
        id: 9,
        html_url: "https://github.com/org/repo/issues/5#issuecomment-9",
      };
    } else if (url.pathname.endsWith("/comments"))
      data = options.comments ?? [];
    else if (url.pathname.includes("/contents/") && options.contentStatus)
      return new Response("{}", { status: options.contentStatus });
    else if (url.pathname.includes("/contents/"))
      data = options.directory
        ? []
        : {
            type: "file",
            size: options.size ?? 5,
            encoding: "base64",
            content: Buffer.from(
              options.fileAt?.(url.searchParams.get("ref")) ?? "hello",
            ).toString("base64"),
          };
    else if (url.pathname === "/repos/org/repo/issues/5")
      data = {
        number: 5,
        title: "untrusted",
        body: "body",
        state: options.issueState ?? "open",
      };
    else throw new Error("unexpected request " + url);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    client: new OctokitGitHubClient(
      config,
      privateKey,
      (i, r) => {
        const binding = config.bindings.find(
          (b) => b.installationId === i && b.repositoryId === r,
        );
        return binding && options.bindingEnabled?.() !== false
          ? { ...binding, deepReview: options.deepReview }
          : undefined;
      },
      async () => {},
      fetchImpl,
    ),
    calls,
  };
}
test("installation token is repository and permission scoped", async () => {
  const { client, calls } = fixture();
  await client.authorize(task);
  assert.deepEqual(calls[0]?.body.repository_ids, [2]);
  assert.deepEqual(calls[0]?.body.permissions, {
    metadata: "read",
    contents: "read",
    issues: "write",
    pull_requests: "write",
  });
});
test("authorization rejects repository drift and weak actor role", async () => {
  await assert.rejects(
    fixture({ repoId: 8 }).client.authorize(task),
    AccessDenied,
  );
  await assert.rejects(
    fixture({ permission: "read" }).client.authorize(task),
    AccessDenied,
  );
  await assert.rejects(
    fixture().client.authorize({ ...task, repo: "other" }),
    AccessDenied,
  );
});
test("reads are scoped, marked untrusted and bounded", async () => {
  const { client, calls } = fixture();
  assert.equal(((await client.readIssue(task)) as any).untrusted, true);
  assert.equal(
    ((await client.readFile(task, "README.md")) as any).content,
    "hello",
  );
  for (const path of [
    "",
    "../secret",
    "/secret",
    "a/../b",
    "a\\b",
    "C:/a",
    "%2e%2e/secret",
  ])
    await assert.rejects(client.readFile(task, path));
  assert.deepEqual(
    await fixture({ directory: true }).client.readFile(task, "folder"),
    { untrusted: true, unavailable: "not_a_file" },
  );
  assert.deepEqual(
    await fixture({ size: 131073 }).client.readFile(task, "large"),
    { untrusted: true, unavailable: "file_too_large" },
  );
  assert.deepEqual(
    await fixture({ contentStatus: 404 }).client.readFile(task, "missing"),
    { untrusted: true, unavailable: "file_unavailable" },
  );
  for (const status of [401, 403, 429, 503])
    await assert.rejects(
      fixture({ contentStatus: status }).client.readFile(task, "README.md"),
    );
  assert.ok(calls.some((x) => x.path === "/repos/org/repo/issues/5"));
});
test("publish reconciles only bot marker and posts once on ambiguous failure", async () => {
  const existing = {
    id: 8,
    html_url: "url",
    body: "<!-- github-agent-channel:task-1 -->",
    user: { login: "helper[bot]" },
  };
  const a = fixture({ comments: [existing] });
  assert.equal((await a.client.publishComment(task, "result")).id, 8);
  assert.equal(a.calls.filter((x) => x.method === "POST").length, 1);
  const b = fixture({
    comments: [{ ...existing, user: { login: "attacker" } }],
  });
  assert.equal((await b.client.publishComment(task, "result")).id, 9);
  const c = fixture({ failWrite: true });
  await assert.rejects(
    c.client.publishComment(task, "result"),
    AmbiguousExecution,
  );
  assert.equal(
    c.calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
      .length,
    1,
  );
});
test("failure notices are only sent to open Issues", async () => {
  const failed: Task = { ...task, status: "failed" };
  const closed = fixture({ issueState: "closed" });
  await assert.rejects(closed.client.authorize(failed), AccessDenied);
  await assert.rejects(
    closed.client.publishComment(failed, "notice"),
    AccessDenied,
  );
  assert.ok(
    !closed.calls.some(
      (c) => c.method === "POST" && c.path.endsWith("/comments"),
    ),
  );

  const open = fixture({ issueState: "open" });
  assert.equal((await open.client.publishComment(failed, "notice")).id, 9);
});

test("an Issue closed without a webhook cannot be assigned or expose tool data", async () => {
  const f = fixture({ issueState: "closed" });
  const running: Task = { ...task, status: "running" };
  for (const check of [
    () => f.client.authorize(running),
    () => f.client.readIssue(running),
    () => f.client.readFile(running, "README.md"),
  ])
    await assert.rejects(check, AccessDenied);
  assert.ok(!f.calls.some((call) => call.path.includes("/contents/")));
});
test("comment scan bound refuses creation and excessive response is refused", async () => {
  const a = fixture({
    comments: Array.from({ length: 100 }, () => ({
      body: "other",
      user: { login: "x" },
    })),
  });
  await assert.rejects(
    a.client.publishComment(task, "result"),
    AmbiguousExecution,
  );
  assert.equal(
    a.calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
      .length,
    0,
  );
  await assert.rejects(
    fixture().client.publishComment(task, "x".repeat(20001)),
  );
});
test("network authorization failure and revoked permission never permit writes", async () => {
  for (const option of [{ failRead: true }, { revokeOnSecondCheck: true }]) {
    const { client, calls } = fixture(option);
    await assert.rejects(client.publishComment(task, "result"));
    assert.equal(
      calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
        .length,
      0,
    );
  }
});
test("expired static scoped token never retries the comment write", async () => {
  const { client, calls } = fixture({ writeStatus: 401 });
  await assert.rejects(client.publishComment(task, "result"));
  assert.equal(
    calls.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
      .length,
    1,
  );
});

test("pull request targets use their canonical number for discussion reads and comments", async () => {
  const f = fixture();
  const pullTask: Task = {
    ...task,
    target: { kind: "pull_request", number: 5, revision },
    source: { event: "pull_request", action: "opened" },
  };
  await f.client.readIssue(pullTask);
  await f.client.publishComment(pullTask, "result");
  assert.ok(
    f.calls.some(
      (call) =>
        call.method === "GET" && call.path === "/repos/org/repo/issues/5",
    ),
  );
  assert.ok(
    f.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/repos/org/repo/issues/5/comments",
    ),
  );
});

test("PR may close between claim and publication; an unverifiable PR also blocks writes", async () => {
  const pr: Task = {
    ...task,
    target: { kind: "pull_request", number: 5, revision },
  };
  for (const pull of [
    { state: "closed", merged: true },
    { state: "closed", merged: false },
    { state: "open" },
    null,
  ]) {
    let open = true;
    const { client, calls } = fixture({
      pull: () => (open ? openPull : pull),
    });
    await client.authorize(pr);
    open = false;
    await assert.rejects(client.publishComment(pr, "review"), AccessDenied);
    await assert.rejects(client.authorize(pr));
    assert.ok(
      !calls.some((c) => c.method === "POST" && c.path.endsWith("/comments")),
    );
  }
});

test("local disable during final PR state read prevents a new comment POST", async () => {
  let enabled = true;
  const { client, calls } = fixture({
    bindingEnabled: () => enabled,
    pull: () => {
      enabled = false;
      return openPull;
    },
  });
  await assert.rejects(
    client.publishComment(
      { ...task, target: { kind: "pull_request", number: 5, revision } },
      "review",
    ),
    AccessDenied,
  );
  assert.equal(
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/comments"))
      .length,
    0,
  );
});

test("only resolution accepts an unpinned PR; foreign heads, stale versions and wrong scopes are denied", async () => {
  const unpinned: Task = {
    ...task,
    target: { kind: "pull_request", number: 5 },
  };
  const { client, calls } = fixture();
  assert.deepEqual(await client.resolvePullRevision(unpinned), revision);
  await assert.rejects(client.authorize(unpinned), AccessDenied);
  await assert.rejects(client.readFile(unpinned, "README.md"), AccessDenied);
  await assert.rejects(client.readPullDiff(task), AccessDenied);
  assert.ok(
    !calls.some(
      (c) => c.path.includes("/contents/") || c.path.includes("/compare/"),
    ),
  );
  for (const drift of [
    { head: { ...openPull.head, repo: { id: 3 } } },
    { head: { ...openPull.head, sha: "3".repeat(40) } },
    { base: { ...openPull.base, sha: "4".repeat(40) } },
    { number: 6 },
  ]) {
    const f = fixture({ pull: () => ({ ...openPull, ...drift }) });
    await assert.rejects(f.client.resolvePullRevision(pinned), AccessDenied);
    await assert.rejects(f.client.readFile(pinned, "README.md"), AccessDenied);
    assert.ok(!f.calls.some((c) => c.path.includes("/contents/")));
  }
});
test("PR file reads use pinned head even when same path exists on default branch", async () => {
  const { client, calls } = fixture({
    fileAt: () => "not-pinned",
    gitObject: pinnedFileObjects(),
  });
  assert.deepEqual(await client.readFile(pinned, "src/readme.md"), {
    untrusted: true,
    revision,
    path: "src/readme.md",
    content: "\uFEFFonly-on-head",
  });
  assert.ok(!calls.some((call) => call.path.includes("/contents/")));
});

function pinnedFileObjects(
  options: {
    mode?: string;
    content?: string;
    truncated?: boolean;
    extra?: string;
    size?: number;
  } = {},
) {
  const root = "3".repeat(40);
  const directory = "4".repeat(40);
  const bytes = Buffer.from("\uFEFFonly-on-head");
  const file = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const fixtures: Record<string, unknown> = {
    [`commits/${revision.headSha}`]: {
      sha: revision.headSha,
      tree: { sha: root },
    },
    [`trees/${root}`]: {
      sha: root,
      truncated: false,
      tree: [{ path: "src", mode: "040000", type: "tree", sha: directory }],
    },
    [`trees/${directory}`]: {
      sha: directory,
      truncated: options.truncated ?? false,
      tree: [
        {
          path: "readme.md",
          mode: options.mode ?? "100644",
          type: "blob",
          sha: file,
          size: options.size ?? bytes.length,
        },
      ],
      ...(options.extra && { extra: options.extra }),
    },
    [`blobs/${file}`]: {
      sha: file,
      encoding: "base64",
      size: bytes.length,
      content: (options.content === undefined
        ? bytes
        : Buffer.from(options.content)
      ).toString("base64"),
    },
  };
  return (path: string) => fixtures[path.replace("/repos/org/repo/git/", "")];
}

test("pinned PR reads never follow symlinks or accept content that does not match the Git blob", async () => {
  const symbolic = fixture({
    gitObject: pinnedFileObjects({ mode: "120000" }),
  });
  assert.deepEqual(await symbolic.client.readFile(pinned, "src/readme.md"), {
    untrusted: true,
    revision,
    path: "src/readme.md",
    unavailable: "not_a_file",
  });
  assert.ok(
    !symbolic.calls.some((call) => /\/(blobs|contents)\//.test(call.path)),
  );

  const tampered = fixture({
    gitObject: pinnedFileObjects({ content: "\uFEFFnot-the-head" }),
  });
  await assert.rejects(
    tampered.client.readFile(pinned, "src/readme.md"),
    /Git object/,
  );
});
test("pinned PR reads distinguish directories, missing files and oversized blobs without exposing content", async () => {
  const { client, calls } = fixture({
    gitObject: pinnedFileObjects({ size: 131073 }),
  });
  for (const [path, unavailable] of [
    ["src", "not_a_file"],
    ["src/missing.md", "file_unavailable"],
    ["src/readme.md", "file_too_large"],
  ]) {
    assert.deepEqual(await client.readFile(pinned, path), {
      untrusted: true,
      revision,
      path,
      unavailable,
    });
  }
  assert.ok(!calls.some((call) => /\/(blobs|contents)\//.test(call.path)));
});

test("a PR change also withholds pinned unavailable results", async () => {
  let checks = 0;
  const { client } = fixture({
    gitObject: pinnedFileObjects(),
    pull: () => (++checks === 1 ? openPull : { ...openPull, state: "closed" }),
  });
  await assert.rejects(client.readFile(pinned, "src/missing.md"), AccessDenied);
  assert.equal(checks, 2);
});
test("pinned PR reads fail closed on partial and oversized Git tree responses", async () => {
  for (const options of [{ truncated: true }, { extra: "x".repeat(512_001) }]) {
    const { client, calls } = fixture({
      gitObject: pinnedFileObjects(options),
    });
    await assert.rejects(client.readFile(pinned, "src/readme.md"));
    assert.ok(!calls.some((call) => /\/(blobs|contents)\//.test(call.path)));
  }
});
const file = {
  filename: "new.ts",
  previous_filename: "old.ts",
  status: "renamed",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-before\n+after",
};
test("pinned SHA compare preserves patch, rename and deletion, and disclose missing material", async () => {
  const { client } = fixture({
    pull: () => ({ ...openPull, changed_files: 2 }),
    files: () => [
      file,
      {
        filename: "deleted.bin",
        status: "removed",
        additions: 0,
        deletions: 0,
      },
    ],
  });
  const diff = await client.readPullDiff(pinned);
  assert.deepEqual(diff.revision, revision);
  assert.equal(diff.files[0]?.patch, file.patch);
  assert.equal(diff.files[0]?.previousPath, "old.ts");
  assert.equal(diff.files[1]?.status, "removed");
  assert.equal(diff.files[1]?.patchStatus, "unavailable");
  assert.ok(diff.limitations.length);
});
test("pinned compare evidence is discarded if the PR moves while reading it", async () => {
  let fetched = false;
  const { client } = fixture({
    pull: () => ({
      ...openPull,
      head: fetched ? { ...openPull.head, sha: "3".repeat(40) } : openPull.head,
    }),
    files: () => {
      fetched = true;
      return [file];
    },
  });
  await assert.rejects(client.readPullDiff(pinned), AccessDenied);
  assert.equal(fetched, true);
});
test("no stale comment is written after reconciliation scan; successful comment identifies exact version", async () => {
  let reads = 0;
  const stale = fixture({
    pull: () =>
      ++reads === 1
        ? openPull
        : { ...openPull, head: { ...openPull.head, sha: "3".repeat(40) } },
  });
  await assert.rejects(
    stale.client.publishComment(pinned, "result"),
    AccessDenied,
  );
  assert.ok(
    !stale.calls.some(
      (c) => c.method === "POST" && c.path.endsWith("/comments"),
    ),
  );
  const good = fixture();
  await good.client.publishComment(pinned, "result");
  assert.ok(
    good.calls
      .find((c) => c.method === "POST" && c.path.endsWith("/comments"))
      ?.body.body.includes(revision.headSha),
  );
});
test("diff collector bounds files and reports both clipped patches and incomplete coverage", async () => {
  const { client, calls } = fixture({
    pull: () => ({ ...openPull, changed_files: 150 }),
    files: () =>
      Array.from({ length: 150 }, (_, i) => ({
        ...file,
        filename: `${i}.ts`,
        patch: i === 0 ? "@@ -0,0 +1 @@\n+" + "a".repeat(40000) : file.patch,
      })),
  });
  const result = await client.readPullDiff(pinned);
  assert.equal(result.files.length, 100);
  assert.equal(result.files[0]?.patchStatus, "truncated");
  assert.equal(calls.filter((c) => c.path.includes("/compare/")).length, 1);
  assert.ok(result.limitations.includes("Changed file list is incomplete"));
});
test("oversized compare response discloses missing evidence without returning partial files", async () => {
  const { client } = fixture({
    files: () => [{ ...file, patch: "x".repeat(4 * 1024 * 1024) }],
  });
  const result = await client.readPullDiff(pinned);
  assert.deepEqual(result.files, []);
  assert.equal(result.changedFiles, 1);
  assert.ok(
    result.limitations.some((reason) => reason.includes("response byte limit")),
  );
});
test("diff collector does not return already fetched data after permission is revoked", async () => {
  const { client, calls } = fixture({
    revokeOnSecondCheck: true,
    files: () => [file],
  });
  await assert.rejects(client.readPullDiff(pinned), AccessDenied);
  assert.ok(calls.some((c) => c.path.includes("/compare/")));
});
test("native review publication requires an explicit binding grant, before listing reviews or writing", async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.publishReview(pinned, "review"), AccessDenied);
  assert.ok(!calls.some((c) => c.path.includes("/reviews")));
});

const sourcePermissions = { contents: "read", metadata: "read" };
const grantResponse = () => ({
  token: "synthetic-read-only",
  expires_at: new Date(Date.now() + 3599000).toISOString(),
  permissions: sourcePermissions,
  repository_selection: "selected",
  repositories: [{ id: 2 }],
});
test("each source grant mints a dedicated token limited to the task repository and its contents", async () => {
  const grants = [
    grantResponse(),
    { ...grantResponse(), token: "second-read-only" },
  ];
  let n = 0;
  const { client, calls } = fixture({
    deepReview: true,
    grant: () => grants[n++],
  });
  for (const grant of grants) {
    assert.deepEqual(await client.issueSourceGrant(pinned, () => {}), {
      token: grant.token,
      expiresAt: grant.expires_at,
    });
  }
  const mint = calls.filter(
    (c) => c.method === "POST" && !c.body.permissions.pull_requests,
  );
  assert.equal(mint.length, 2);
  for (const c of mint)
    assert.deepEqual(c.body, {
      repository_ids: [2],
      permissions: sourcePermissions,
    });
});
test("a wider, incomplete, invalid or expired source grant is withheld", async () => {
  for (const override of [
    { permissions: { ...sourcePermissions, issues: "read" } },
    { permissions: { ...sourcePermissions, contents: "write" } },
    { permissions: { metadata: "read" } },
    { repository_selection: "all" },
    { repositories: [{ id: 3 }] },
    { repositories: [{ id: 2 }, { id: 3 }] },
    { repositories: undefined },
    { expires_at: "invalid" },
    { expires_at: new Date(0).toISOString() },
    { expires_at: new Date(Date.now() + 7200000).toISOString() },
    { token: "" },
  ]) {
    const { client } = fixture({
      deepReview: true,
      grant: () => ({ ...grantResponse(), ...override }),
    });
    await assert.rejects(
      client.issueSourceGrant(pinned, () => {}),
      AccessDenied,
    );
  }
});
test("source grants require deep binding, authorized actor and unchanged PR before and after mint", async () => {
  for (const scenario of [
    "disabled",
    "issue",
    "revocation",
    "new-head",
    "denied-before",
  ]) {
    let minted = false;
    const { client } = fixture({
      deepReview: scenario !== "disabled",
      grant: () => {
        minted = true;
        return grantResponse();
      },
      permission: scenario === "denied-before" ? "read" : "write",
      revokeOnSecondCheck: scenario === "revocation",
      pull: () =>
        scenario === "new-head" && minted
          ? { ...openPull, head: { ...openPull.head, sha: "f".repeat(40) } }
          : openPull,
    });
    await assert.rejects(
      client.issueSourceGrant(scenario === "issue" ? task : pinned, () => {}),
      AccessDenied,
    );
    assert.equal(minted, ["revocation", "new-head"].includes(scenario));
  }
});
