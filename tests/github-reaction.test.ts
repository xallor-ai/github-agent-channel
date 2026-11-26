import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { OctokitGitHubClient } from "../src/github.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type ChannelConfig,
  type Task,
} from "../src/contracts.js";
import { ReactionWorker } from "../src/reaction-worker.js";
import { reactionFailure } from "../src/github-reaction.js";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  github: { appId: "123", botLogin: "helper[bot]" },
} as ChannelConfig;
const task = {
  id: "one",
  installationId: 1,
  repositoryId: 2,
  bindingId: "b",
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "alice",
  source: { event: "issue_comment", action: "created", commentId: 4 },
  target: { kind: "pull_request", number: 5 },
} as Task;
const mine = {
  id: 6,
  content: "eyes",
  user: { id: 7, type: "Bot", login: "helper[bot]" },
};
const other = {
  ...mine,
  id: 8,
  user: { id: 9, type: "Bot", login: "other[bot]" },
};
function fixture(
  options: {
    commentAuthor?: string;
    authorLogin?: string;
    authorId?: number;
    repoId?: number;
    retired?: boolean;
    commentTarget?: number;
    fork?: boolean;
    closed?: boolean;
    app?: string;
    denyAfterRead?: boolean;
    postStatus?: number;
    postHeaders?: Record<string, string>;
    postReply?: unknown;
    listed?: unknown[];
    commentDeleted?: boolean;
  } = {},
) {
  let posts = 0,
    checks = 0;
  const scopes: Record<string, string>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname,
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (v: unknown, s = 200) => Response.json(v, { status: s });
    if (path === "/app/installations/1/access_tokens") {
      assert.deepEqual(body.repository_ids, [2]);
      scopes.push(body.permissions);
      return json({
        token: "fake",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
      });
    }
    if (path === "/app")
      return json({ id: 123, slug: options.app ?? "helper" });
    if (path === "/repos/org/repo")
      return json({
        id: options.repoId ?? 2,
        name: "repo",
        owner: { login: "org" },
      });
    if (path.endsWith("/permission"))
      return json({
        permission: options.denyAfterRead && checks++ > 0 ? "read" : "write",
        user: { id: 3, login: "alice" },
      });
    if (path.endsWith("/issues/comments/4")) {
      if (options.commentDeleted) return json({}, 404);
      return json({
        id: 4,
        user: {
          id: options.authorId ?? 3,
          login: options.authorLogin ?? "alice",
          type: options.commentAuthor ?? "User",
        },
        issue_url:
          "https://api.github.com/repos/org/repo/issues/" +
          (options.commentTarget ?? 5),
      });
    }
    if (path.endsWith("/pulls/5"))
      return json({
        number: 5,
        state: options.closed ? "closed" : "open",
        merged: false,
        base: { repo: { id: 2 } },
        head: { repo: { id: options.fork ? 20 : 2 } },
      });
    if (path.endsWith("/issues/5"))
      return json({ number: 5, state: options.closed ? "closed" : "open" });
    if (path.endsWith("/issues/comments/4/reactions")) {
      if (init?.method === "POST") {
        posts++;
        assert.deepEqual(body, { content: "eyes" });
        return Response.json(options.postReply ?? mine, {
          status: options.postStatus ?? 201,
          headers: options.postHeaders,
        });
      }
      return json(options.listed ?? [other]);
    }
    throw Error("Unexpected path " + path);
  };
  const github = new OctokitGitHubClient(
    config,
    key,
    () =>
      options.retired
        ? undefined
        : {
            id: "b",
            installationId: 1,
            repositoryId: 2,
            owner: "org",
            repo: "repo",
            enabled: true,
            events: ["issue_comment.created"],
          },
    async () => {},
    fetcher,
  );
  return { github, scopes, posts: () => posts };
}
test("an unclaimed PR or issue comment may receive its own App's eyes; tokens have no review or Git Data write permission", async () => {
  for (const kind of ["issue", "pull_request"] as const) {
    const f = fixture({ postStatus: kind === "issue" ? 200 : 201 });
    const id = await f.github.publishOwnerReaction(
      { ...task, target: { kind, number: 5 } },
      () => {},
    );
    assert.equal(id, 6);
    assert.equal(f.posts(), 1);
    assert.ok(f.scopes.length);
    assert.deepEqual(f.scopes[0], {
      metadata: "read",
      pull_requests: "read",
      issues: "write",
    });
  }
});
test("denied actor, non-human author, wrong thread, closed/fork target, inactive receipt and wrong App never publish", async () => {
  for (const scenario of [
    { denyAfterRead: true },
    { commentAuthor: "Bot" },
    { commentTarget: 15 },
    { closed: true },
    { fork: true },
    { app: "other" },
  ]) {
    const f = fixture(scenario);
    await assert.rejects(
      f.github.publishOwnerReaction(task, () => {}),
      AccessDenied,
    );
    assert.equal(f.posts(), 0);
  }
  const f = fixture();
  await assert.rejects(
    f.github.publishOwnerReaction(task, () => {
      throw new AccessDenied("fenced");
    }),
    AccessDenied,
  );
  assert.equal(f.posts(), 0);
});
test("reconciliation only finds exact bot eyes; identity or incomplete writes do not become success", async () => {
  for (const [listed, expected] of [
    [[other], null],
    [[other, mine], 6],
  ] as const) {
    const f = fixture({ listed: [...listed], closed: true });
    assert.equal(await f.github.lookupOwnerReaction(task), expected);
    assert.equal(f.posts(), 0);
    assert.equal(f.scopes[0].issues, "read");
  }
  await assert.rejects(
    fixture({ listed: [mine, { ...mine, id: 23 }] }).github.lookupOwnerReaction(
      task,
    ),
    AmbiguousExecution,
  );
  await assert.rejects(
    fixture({ postReply: other }).github.publishOwnerReaction(task, () => {}),
    AmbiguousExecution,
  );
  for (const [scenario, reason] of [
    [{ postStatus: 429 }, "rate_limited"],
    [{ postStatus: 403 }, "forbidden"],
    [{ commentDeleted: true }, "comment_unavailable"],
    [{ postStatus: 500 }, "unconfirmed"],
  ] as const) {
    await assert.rejects(
      fixture(scenario).github.publishOwnerReaction(task, () => {}),
      (e) => reactionFailure(e).reason === reason,
    );
  }
});
test("only historical admin reconciliation confirms matching eyes after binding retirement and author rename", async () => {
  const retired = {
    retired: true,
    closed: true,
    authorLogin: "renamed",
    listed: [mine],
  };
  const f = fixture(retired);
  await assert.rejects(f.github.lookupOwnerReaction(task), AccessDenied);
  await assert.rejects(
    f.github.publishOwnerReaction(task, () => {}),
    AccessDenied,
  );
  assert.equal(await f.github.reconcileOwnerReaction(task), 6);
  assert.deepEqual(f.scopes, [{ metadata: "read", issues: "read" }]);
  assert.equal(f.posts(), 0);
  for (const mismatch of [
    { repoId: 90 },
    { app: "different" },
    { authorId: 10 },
    { commentTarget: 8 },
  ]) {
    const bad = fixture({ ...retired, ...mismatch });
    await assert.rejects(bad.github.reconcileOwnerReaction(task), AccessDenied);
    assert.equal(bad.posts(), 0);
  }
  assert.equal(
    await fixture({
      ...retired,
      listed: [other],
    }).github.reconcileOwnerReaction(task),
    null,
  );
});
test("only GitHub rate-limit signals set an installation delay; response bodies never enter the receipt", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3500;
  const cases = [
    {
      headers: { "x-ratelimit-remaining": "17" },
      body: {
        message:
          "You have exceeded a secondary rate limit. Please wait before trying again.",
      },
      delay: 60,
    },
    { headers: { "retry-after": "120" }, body: {}, delay: 120 },
    {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
      body: {},
      delay: 3400,
    },
    {
      headers: {},
      body: {
        documentation_url:
          "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits",
      },
      delay: 60,
    },
    {
      headers: {},
      body: { message: "Resource not accessible by integration" },
      delay: 0,
    },
  ] satisfies {
    headers: Record<string, string>;
    body: unknown;
    delay: number;
  }[];
  for (const { headers, body, delay } of cases) {
    const f = fixture({
      postStatus: 403,
      postHeaders: headers,
      postReply: body,
    });
    const before = Date.now();
    let visited = false;
    const worker = new ReactionWorker(
      {
        reserveReaction: () => task,
        reactionAllowed: () => true,
        finishReaction(_id, r) {
          visited = true;
          assert.equal(r.status, "failed");
          if (r.status !== "failed") assert.fail();
          assert.equal(r.reason, delay ? "rate_limited" : "forbidden");
          if (delay)
            assert.ok(
              r.retryAt !== undefined && r.retryAt >= before + delay * 1000,
            );
          else assert.equal(r.retryAt, undefined);
          assert.deepEqual(
            Object.keys(r).sort(),
            delay ? ["reason", "retryAt", "status"] : ["reason", "status"],
          );
        },
      },
      f.github,
    );
    await worker.tick();
    assert.equal(visited, true);
    assert.equal(f.posts(), 1);
  }
});
test("worker never repeats a lost POST; lookup can confirm only a matching reaction", async () => {
  for (const found of [true, false]) {
    const f = fixture({ postStatus: 500, listed: found ? [mine] : [other] });
    let reservation = true,
      final: unknown;
    const worker = new ReactionWorker(
      {
        reserveReaction() {
          if (!reservation) return;
          reservation = false;
          return task;
        },
        reactionAllowed: () => true,
        finishReaction(_id, r) {
          final = r;
        },
      },
      f.github,
    );
    assert.equal(await worker.tick(), true);
    assert.equal(await worker.tick(), false);
    assert.equal(f.posts(), 1);
    assert.deepEqual(
      final,
      found
        ? { status: "sent", reactionId: 6 }
        : { status: "unknown", reason: "unconfirmed" },
    );
  }
});
