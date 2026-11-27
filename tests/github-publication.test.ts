import { validateProposal } from "../src/github-publication.js";
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubClient } from "../src/github.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type ChannelConfig,
  type Task,
  type PublicationRequest,
} from "../src/contracts.js";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const sha = "a".repeat(40);
const task = {
  id: "00000000-0000-4000-8000-000000000001",
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "reader",
  target: { kind: "repository" },
  source: { event: "push" },
} as Task;
const proposal: Extract<PublicationRequest, { kind: "pull_request" }> = {
  kind: "pull_request",
  title: "Fix",
  body: "Details",
  baseBranch: "main",
  baseSha: sha,
  files: [{ path: "src/a.txt", content: "hello" }],
};
function fixture(
  opts: {
    noPolicy?: boolean;
    stale?: boolean;
    revokeAt?: number;
    conflict?: boolean;
    lost?: string;
    tree?: any[];
    maxFiles?: number;
    maxBytes?: number;
    writeStatus?: number;
    incomplete?: boolean;
  } = {},
) {
  const calls: { path: string; method: string; body: any }[] = [];
  let checks = 0;
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
        ...(opts.noPolicy
          ? {}
          : {
              writePolicy: {
                baseBranch: "main",
                allowedPaths: ["src/"],
                maxFiles: opts.maxFiles ?? 10,
                maxBytes: opts.maxBytes ?? 1000,
              },
            }),
      },
    ],
  } as unknown as ChannelConfig & {
    bindings: import("../src/contracts.js").Binding[];
  };
  const fetcher = (async (input: any, init: any) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    let data: any;
    if (path.includes("/access_tokens"))
      data = {
        token: "fake",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
        repository_selection: "selected",
        repositories: [{ id: 2 }],
      };
    else if (path === "/repos/org/repo")
      data = { id: 2, name: "repo", owner: { login: "org" } };
    else if (method === "GET" && path === "/repos/org/repo/pulls/5")
      data = {
        state: "open",
        merged: false,
        number: 5,
        base: { sha: "a".repeat(40), repo: { id: 2 } },
        head: { sha: "b".repeat(40), repo: { id: 2 } },
      };
    else if (path.endsWith("/permission"))
      data = {
        permission: ++checks >= (opts.revokeAt ?? Infinity) ? "read" : "write",
        user: { id: 3, login: "reader" },
      };
    else if (method === "GET" && path.includes("/git/ref/heads/channel/")) {
      if (!opts.conflict) return new Response("{}", { status: 404 });
      data = { object: { sha } };
    } else if (method === "GET" && path.endsWith("/git/ref/heads/main"))
      data = { object: { sha: opts.stale ? "b".repeat(40) : sha } };
    else if (method === "GET" && path.includes("/git/commits/"))
      data = { sha, tree: { sha: "c".repeat(40) } };
    else if (method === "GET" && path.includes("/git/trees/"))
      data = { truncated: false, tree: opts.tree ?? [] };
    else if (method === "POST") {
      if (opts.writeStatus)
        return new Response("{}", { status: opts.writeStatus });
      if (opts.incomplete)
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (opts.lost && path.endsWith(opts.lost))
        throw new Error("lost response");
      data = path.endsWith("/pulls")
        ? { id: 7, html_url: "https://github.com/org/repo/pull/7" }
        : { sha: "d".repeat(40), object: { sha: "d".repeat(40) } };
    } else throw new Error("unexpected " + method + " " + path);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    client: new OctokitGitHubClient(
      config,
      key,
      (i, r) =>
        config.bindings.find(
          (b) => b.installationId === i && b.repositoryId === r,
        ),
      async () => {},
      fetcher,
    ),
    calls,
    mutations: () =>
      calls.filter(
        (c) => c.method === "POST" && !c.path.includes("access_tokens"),
      ),
  };
}
test("draft PR uses scoped token, fixed branch and authorized Git Data writes", async () => {
  const f = fixture();
  assert.deepEqual(await f.client.publishPullRequest(task, proposal), {
    id: 7,
    url: "https://github.com/org/repo/pull/7",
  });
  assert.deepEqual(
    f.mutations().map((c) => c.path.split("/").at(-1)),
    ["blobs", "trees", "commits", "refs", "pulls"],
  );
  const token = f.calls.find(
    (c) =>
      c.path.includes("access_tokens") &&
      c.body.permissions.contents === "write",
  );
  assert.deepEqual(token?.body.repository_ids, [2]);
  assert.equal(f.mutations().at(-2)?.body.ref, `refs/heads/channel/${task.id}`);
  assert.equal(f.mutations().at(-1)?.body.draft, true);
  assert.equal(f.mutations().at(-1)?.body.base, "main");
  assert.ok(f.calls.filter((c) => c.path.endsWith("/permission")).length >= 6);
});
test("policy, base, branch and authorization denials perform no writes", async () => {
  for (const opts of [
    { noPolicy: true },
    { stale: true },
    { conflict: true },
    { revokeAt: 1 },
    { revokeAt: 2 },
  ]) {
    const f = fixture(opts);
    await assert.rejects(
      f.client.publishPullRequest(task, proposal),
      AccessDenied,
    );
    assert.equal(f.mutations().length, 0);
  }
});
test("rejects path escapes, protected paths, collisions and size policy", async () => {
  for (const path of [
    "../a",
    "src/../a",
    "src\\a",
    "/src/a",
    "src/%2e/a",
    "src/.git/config",
    ".GitHub/workflows/a.yml",
    "else/a",
    "src/a.",
    "src/AUX",
  ]) {
    const f = fixture();
    await assert.rejects(
      f.client.publishPullRequest(task, {
        ...proposal,
        files: [{ path, content: "x" }],
      }),
      AccessDenied,
    );
    assert.equal(f.mutations().length, 0);
  }
  for (const files of [
    [
      { path: "src/a", content: "x" },
      { path: "src/A", content: "y" },
    ],
    [
      { path: "src/a", content: "x" },
      { path: "src/a/b", content: "y" },
    ],
  ])
    await assert.rejects(
      fixture().client.publishPullRequest(task, { ...proposal, files }),
      AccessDenied,
    );
  for (const opts of [
    { maxBytes: 1 },
    { maxFiles: 0 },
    { tree: [{ path: "src", mode: "120000", type: "blob", sha }] },
  ]) {
    const f = fixture(opts);
    await assert.rejects(
      f.client.publishPullRequest(task, proposal),
      AccessDenied,
    );
    assert.equal(f.mutations().length, 0);
  }
});
test("deletion requires existing regular file and preserves executable modes", async () => {
  const f = fixture({
    tree: [{ path: "src/a.txt", mode: "100755", type: "blob", sha }],
  });
  await f.client.publishPullRequest(task, {
    ...proposal,
    files: [{ path: "src/a.txt", content: null }],
  });
  assert.equal(f.mutations()[0]?.body.tree[0].sha, null);
  await assert.rejects(
    fixture().client.publishPullRequest(task, {
      ...proposal,
      files: [{ path: "src/missing", content: null }],
    }),
    AccessDenied,
  );
  const executable = fixture({
    tree: [{ path: "src/a.txt", mode: "100755", type: "blob", sha }],
  });
  await executable.client.publishPullRequest(task, proposal);
  assert.equal(executable.mutations()[1]?.body.tree[0].mode, "100755");
});
test("each uncertain write stops without retry or subsequent mutation", async () => {
  for (const lost of ["/blobs", "/trees", "/commits", "/refs", "/pulls"]) {
    const f = fixture({ lost });
    await assert.rejects(
      f.client.publishPullRequest(task, proposal),
      AmbiguousExecution,
    );
    assert.equal(f.mutations().filter((c) => c.path.endsWith(lost)).length, 1);
    assert.ok(f.mutations().at(-1)?.path.endsWith(lost));
  }
  const f = fixture({ revokeAt: 3 });
  await assert.rejects(
    f.client.publishPullRequest(task, proposal),
    AccessDenied,
  );
  assert.equal(f.mutations().length, 1);
});
test("repository tasks cannot read issues or publish comments", async () => {
  const f = fixture();
  await assert.rejects(f.client.readIssue(task), AccessDenied);
  await assert.rejects(f.client.publishComment(task, "hello"), AccessDenied);
  assert.equal(f.calls.length, 0);
});

test("rejected static write token and incomplete responses never replay", async () => {
  const rejected = fixture({ writeStatus: 401 });
  await assert.rejects(rejected.client.publishPullRequest(task, proposal));
  assert.equal(rejected.mutations().length, 1);
  const incomplete = fixture({ incomplete: true });
  await assert.rejects(
    incomplete.client.publishPullRequest(task, proposal),
    AmbiguousExecution,
  );
  assert.equal(incomplete.mutations().length, 1);
});
test("rejects branch mismatch and special tree modes before mutation", async () => {
  const mismatch = fixture();
  await assert.rejects(
    mismatch.client.publishPullRequest(task, {
      ...proposal,
      baseBranch: "other",
    }),
    AccessDenied,
  );
  assert.equal(mismatch.calls.length, 0);
  for (const entry of [
    { path: "src/a.txt", mode: "120000", type: "blob", sha },
    { path: "src/a.txt", mode: "160000", type: "commit", sha },
    { path: "SRC", mode: "040000", type: "tree", sha },
  ]) {
    const f = fixture({ tree: [entry] });
    await assert.rejects(
      f.client.publishPullRequest(task, proposal),
      AccessDenied,
    );
    assert.equal(f.mutations().length, 0);
  }
});

test("new files cannot introduce differently cased parent directories", async () => {
  const f = fixture();
  await assert.rejects(
    f.client.publishPullRequest(task, {
      ...proposal,
      files: [
        { path: "src/New/a", content: "a" },
        { path: "src/new/b", content: "b" },
      ],
    }),
    AccessDenied,
  );
  assert.equal(f.mutations().length, 0);
});

test("omitted maxBytes defaults to 512 KiB", () => {
  const policy = { baseBranch: "main", allowedPaths: ["src/"] };
  assert.doesNotThrow(() =>
    validateProposal(task, policy, {
      ...proposal,
      files: [{ path: "src/a", content: "x".repeat(524288) }],
    }),
  );
  assert.throws(
    () =>
      validateProposal(task, policy, {
        ...proposal,
        files: [{ path: "src/a", content: "x".repeat(524289) }],
      }),
    AccessDenied,
  );
});

test("PR linkage uses canonical task target", async () => {
  for (const kind of ["issue", "pull_request"] as const) {
    const f = fixture();
    await f.client.publishPullRequest(
      {
        ...task,
        target:
          kind === "issue"
            ? { kind, number: 5 }
            : {
                kind,
                number: 5,
                revision: {
                  baseSha: "a".repeat(40),
                  headSha: "b".repeat(40),
                  baseRepoId: 2,
                  headRepoId: 2,
                },
              },
      },
      proposal,
    );
    assert.equal(
      f.mutations().at(-1)?.body.body,
      `Details\n\nRelated ${kind === "issue" ? "issue" : "pull request"}: #5.`,
    );
  }
  const f = fixture();
  await f.client.publishPullRequest(task, proposal);
  assert.equal(f.mutations().at(-1)?.body.body, "Details");
});
