import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubClient } from "../src/github.js";
import { Octokit } from "@octokit/core";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AccessDenied,
  AmbiguousExecution,
  type ChannelConfig,
  type Task,
} from "../src/contracts.js";
import {
  publishNativeReview,
  reconcileNativeReview,
} from "../src/github-review.js";
const sha = "a".repeat(40);
const target = {
  kind: "pull_request",
  number: 6,
  revision: {
    headSha: sha,
    baseSha: "b".repeat(40),
    baseRepoId: 2,
    headRepoId: 3,
  },
} as const;
const task = {
  id: "review-task",
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  target,
  outcome: { publication: { kind: "review" }, text: "summary", artifacts: [] },
} as Task;
const url = "https://github.com/org/repo/pull/6#pullrequestreview-8";
const bot = "channel[bot]";
const expected = {
  id: 8,
  html_url: url,
  body: `summary\n\n<!-- github-agent-channel:review:review-task:${sha} -->`,
  commit_id: sha,
  state: "COMMENTED",
  user: { login: bot },
};
function fixture({
  listed = [],
  result = expected,
  fail = false,
}: { listed?: unknown[]; result?: unknown; fail?: boolean } = {}) {
  const writes: unknown[] = [];
  const client = new Octokit({
    request: {
      fetch: async (input: string, init: RequestInit) => {
        const path = new URL(input).pathname;
        let value: unknown;
        if (
          path === "/repos/org/repo/pulls/6/reviews" &&
          init.method === "POST"
        ) {
          writes.push(JSON.parse(String(init.body)));
          if (fail) throw Error("response lost");
          value = result;
        } else if (
          path === "/repos/org/repo/pulls/6/reviews" &&
          init.method === "GET"
        )
          value = listed;
        else if (
          path === "/repos/org/repo/pulls/6/reviews/8" &&
          init.method === "GET"
        )
          value = result;
        else throw Error("unexpected request");
        return Response.json(value);
      },
    },
  });
  return { client, writes };
}
test("native review submits COMMENT on the pinned commit, returns a verified receipt", async () => {
  const f = fixture();
  assert.deepEqual(
    await publishNativeReview(task, "summary", f.client, bot, async () => {}),
    { id: 8, url },
  );
  assert.deepEqual(f.writes, [
    { body: expected.body, event: "COMMENT", commit_id: sha },
  ]);
});
test("lost response or inconsistent returned review is uncertain with a single POST", async () => {
  for (const opts of [
    { fail: true },
    { result: { ...expected, commit_id: "c".repeat(40) } },
    { result: { ...expected, state: "APPROVED" } },
    { result: { ...expected, html_url: "https://example.com" } },
  ]) {
    const f = fixture(opts);
    await assert.rejects(
      publishNativeReview(task, "summary", f.client, bot, async () => {}),
      AmbiguousExecution,
    );
    assert.equal(f.writes.length, 1);
  }
});
test("preflight change blocks POST; already published review is found without a write", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    publishNativeReview(task, "summary", f.client, bot, async () => {
      if (++checks === 2) throw Error("revoked");
    }),
    AccessDenied,
  );
  assert.equal(f.writes.length, 0);
  const existing = fixture({ listed: [expected] });
  assert.deepEqual(
    await publishNativeReview(
      task,
      "summary",
      existing.client,
      bot,
      async () => {},
    ),
    { id: 8, url },
  );
  assert.equal(existing.writes.length, 0);
});
test("read back verifies body, marker, author, state, commit, id and URL before recovery", async () => {
  assert.deepEqual(
    await reconcileNativeReview(task, 8, fixture().client, bot),
    { id: 8, url },
  );
  for (const changed of [
    { body: "missing" },
    { body: "altered" + expected.body },
    { user: { login: "user" } },
    { id: 9 },
    { commit_id: "c".repeat(40) },
    { state: "APPROVED" },
    { html_url: "https://github.com/org/repo/pull/7#pullrequestreview-8" },
  ]) {
    const f = fixture({ result: { ...expected, ...changed } });
    await assert.rejects(
      reconcileNativeReview(task, 8, f.client, bot),
      AmbiguousExecution,
    );
    assert.equal(f.writes.length, 0);
  }
});

test("production native publisher rechecks bound policy, authorization and both PR revisions after marker scan", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const config = { github: { appId: "123", botLogin: bot } } as ChannelConfig;
  for (const mode of [
    "ok",
    "disabled",
    "initial-read-failed",
    "scan-failed",
    "revoke",
    "actor",
    "head",
    "base",
    "closed",
    "fork",
  ] as const) {
    let scanned = false,
      writes = 0;
    const binding = {
      id: "binding",
      installationId: 1,
      repositoryId: 2,
      owner: "org",
      repo: "repo",
      enabled: true,
      events: ["pull_request"],
      nativeReview: mode !== "disabled",
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "scoped",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      if (mode === "initial-read-failed" && path === "/repos/org/repo")
        throw Error("Read timed out");
      if (path === "/repos/org/repo")
        return Response.json({ id: 2, name: "repo", owner: { login: "org" } });
      if (path.endsWith("/permission"))
        return Response.json({
          permission: mode === "actor" && scanned ? "read" : "write",
          user: { id: 3, login: "alice" },
        });
      if (path.endsWith("/pulls/6"))
        return Response.json({
          number: 6,
          state: mode === "closed" && scanned ? "closed" : "open",
          merged: false,
          base: {
            repo: { id: 2 },
            sha:
              mode === "base" && scanned
                ? "e".repeat(40)
                : target.revision.baseSha,
          },
          head: {
            repo: { id: mode === "fork" && scanned ? 3 : 2 },
            sha: mode === "head" && scanned ? "f".repeat(40) : sha,
          },
        });
      if (path.endsWith("/pulls/6/reviews") && init?.method === "GET") {
        if (mode === "scan-failed") throw Error("GET response lost");
        scanned = true;
        if (mode === "revoke") binding.nativeReview = false;
        return Response.json([]);
      }
      if (path.endsWith("/pulls/6/reviews") && init?.method === "POST") {
        writes++;
        return Response.json(expected);
      }
      throw Error("Unexpected request");
    };
    const client = new OctokitGitHubClient(
      config,
      key,
      () => binding,
      async () => {},
      fetchImpl,
    );
    const publish = client.publishReview(
      {
        ...task,
        installationId: 1,
        actorId: 3,
        actorLogin: "alice",
        bindingId: binding.id,
        target: { ...target, revision: { ...target.revision, headRepoId: 2 } },
      },
      "summary",
    );
    if (mode === "ok") assert.deepEqual(await publish, { id: 8, url });
    else await assert.rejects(publish, AccessDenied);
    assert.equal(writes, mode === "ok" ? 1 : 0, mode);
  }
});
test("scan limit and conflicting prior body cannot trigger another review", async () => {
  for (const listed of [
    Array.from({ length: 100 }, () => ({
      ...expected,
      user: { login: "unrelated" },
    })),
    [{ ...expected, body: "different " + expected.body }],
  ]) {
    const f = fixture({ listed });
    await assert.rejects(
      publishNativeReview(task, "summary", f.client, bot, async () => {}),
      listed.length === 100 ? AccessDenied : AmbiguousExecution,
    );
    assert.equal(f.writes.length, 0);
  }
});

test("admin recovery verifies only the original repository and review with installation read access", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const persisted = {
    ...task,
    installationId: 1,
    deliveryStatus: "unknown" as const,
    target: { ...target, revision: { ...target.revision, headRepoId: 2 } },
  };
  for (const mode of [
    "revoked-binding",
    "replacement-repo",
    "uninstalled",
  ] as const) {
    const calls: string[] = [];
    const client = new OctokitGitHubClient(
      { github: { appId: "123", botLogin: bot } } as ChannelConfig,
      key,
      () => undefined,
      async () => {
        throw Error("manager no longer authorized");
      },
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(init?.method + " " + path);
        if (
          path === "/app/installations/1/access_tokens" &&
          init?.method === "POST"
        ) {
          const scope = JSON.parse(String(init.body));
          assert.deepEqual(scope.repository_ids, [2]);
          assert.deepEqual(scope.permissions, {
            metadata: "read",
            pull_requests: "read",
          });
          if (mode === "uninstalled")
            return Response.json({ message: "not found" }, { status: 404 });
          return Response.json({
            token: "scoped",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          });
        }
        if (path === "/repos/org/repo" && init?.method === "GET")
          return Response.json({
            id: mode === "replacement-repo" ? 99 : 2,
            name: "repo",
            owner: { login: "org" },
          });
        if (
          path === "/repos/org/repo/pulls/6/reviews/8" &&
          init?.method === "GET"
        )
          return Response.json(expected);
        throw Error("unexpected operation");
      },
    );
    if (mode === "revoked-binding")
      assert.deepEqual(await client.reconcileReview(persisted, 8), {
        id: 8,
        url,
      });
    else await assert.rejects(client.reconcileReview(persisted, 8));
    const expectedCalls = ["POST /app/installations/1/access_tokens"];
    if (mode !== "uninstalled") expectedCalls.push("GET /repos/org/repo");
    if (mode === "revoked-binding")
      expectedCalls.push("GET /repos/org/repo/pulls/6/reviews/8");
    assert.deepEqual(calls, expectedCalls);
  }
});
