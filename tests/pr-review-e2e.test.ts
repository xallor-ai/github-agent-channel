import { fixtureAgent } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/store.js";
import { PullCoordinator } from "../src/pull.js";
import { createChannelServer } from "../src/server.js";
import { DeliveryWorker } from "../src/worker.js";
import { OctokitGitHubClient } from "../src/github.js";
import { Agent } from "../src/agent.js";
import { AgentStore } from "../src/agent-store.js";
import { OpenClawConnector } from "../src/connector.js";
import type { AgentConfig } from "../src/agent-config.js";
import type { ChannelConfig } from "../src/contracts.js";

const baseSha = "a".repeat(40),
  h1 = "1".repeat(40),
  h2 = "2".repeat(40),
  h3 = "3".repeat(40),
  emptyCommit = "4".repeat(40),
  rewritten = "5".repeat(40);
const revision = (headSha: string) => ({
  baseSha,
  headSha,
  baseRepoId: 2,
  headRepoId: 2,
});
const sender = { id: 5, login: "alice", type: "User" };
const config: ChannelConfig = {
  server: { host: "127.0.0.1", port: 0, adminTokenEnv: "ADMIN" },
  dataFile: ":memory:",
  github: {
    appId: "123",
    botLogin: "fixture[bot]",
    privateKeyEnv: "KEY",
    webhookSecretEnv: "HOOK",
  },
  connector: { timeoutMs: 30_000 },
};
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const reviewUrl = "https://github.com/org/repo/pull/7#pullrequestreview-23";
const json = (body: unknown) => Response.json(body);

async function fixture(
  t: test.TestContext,
  deepReview = false,
  duringMint?: (store: TaskStore) => void,
  nativeReview = true,
) {
  const dir = mkdtempSync(join(tmpdir(), "versioned-pr-e2e-"));
  const database = join(dir, "channel.db"),
    store = new TaskStore(database);
  store.registry.apply(
    {
      installationId: 1,
      repositoryId: 2,
      owner: "org",
      repo: "repo",
      deviceId: "bridge",
      administratorId: 44,
    },
    0,
    {
      enabled: true,
      responsibleAgent: fixtureAgent,
      autoReview: true,
      nativeReview,
      deepReview,
      events: [
        "push",
        "pull_request.opened",
        "pull_request.synchronize",
        "issue_comment.created",
      ],
    },
  );
  let head = h1;
  let reviewerCanWrite = true;
  let closed = false;
  let baseRef = "main";
  const replies: string[] = [];
  const postedAt = Math.floor(Date.now() / 1000) * 1000 - 5_000;
  let loseNextComment = false;
  let loseNextReview = false;
  let onMarkerScan: (() => Promise<void>) | undefined;
  const commentRow = (body: string, index: number) => ({
    id: 31 + index,
    body,
    user: { type: "Bot", login: "fixture[bot]" },
    issue_url: "https://api.github.com/repos/org/repo/issues/7",
    html_url: "https://github.com/org/repo/pull/7#issuecomment-" + (31 + index),
    created_at: new Date(postedAt + index * 1000).toISOString(),
  });
  const reviews: { commit_id: string; body: string }[] = [];
  const markers = new Map([
    [h1, "FIRST_ONLY"],
    [h2, "SECOND_ONLY"],
    [h3, "THIRD_ONLY"],
    [emptyCommit, "THIRD_ONLY"], // New commit, unchanged PR diff.
    [rewritten, "REWRITTEN_ONLY"],
  ]);
  const filesRead: string[] = [];
  const gitTransport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname,
      method = init?.method ?? "GET";
    if (path === "/app") return json({ id: 123, slug: "fixture" });
    if (path === "/repos/org/repo/issues/comments/8")
      return json({
        id: 8,
        user: sender,
        issue_url: "https://api.github.com/repos/org/repo/issues/7",
      });
    if (path === "/app/installations/1/access_tokens") {
      if (!JSON.parse(String(init?.body)).permissions.pull_requests)
        duringMint?.(store);
      return json({
        token: "synthetic-installation",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: JSON.parse(String(init?.body)).permissions,
        repository_selection: "selected",
        repositories: [{ id: 2 }],
      });
    }
    if (path === "/repos/org/repo")
      return json({ id: 2, name: "repo", owner: { login: "org" } });
    if (path.endsWith("/collaborators/alice/permission"))
      return json({
        permission: reviewerCanWrite ? "write" : "read",
        user: sender,
      });
    if (path.endsWith("/pulls/7"))
      return Response.json(
        {
          number: 7,
          state: closed ? "closed" : "open",
          merged: false,
          changed_files: 1,
          base: { sha: baseSha, ref: baseRef, repo: { id: 2 } },
          head: { sha: head, repo: { id: 2 } },
        },
        { headers: { date: new Date().toUTCString() } },
      );
    if (path === "/graphql") {
      const { query } = JSON.parse(String(init?.body));
      const identity = { databaseId: 2, nameWithOwner: "org/repo" };
      const pr = {
        number: 7,
        baseRefName: baseRef,
        baseRefOid: baseSha,
        headRefOid: head,
        baseRepository: identity,
        headRepository: identity,
      };
      if (query.includes("MergeLifecycle"))
        return json({
          data: {
            repository: {
              ...identity,
              pullRequest: {
                ...pr,
                state: closed ? "CLOSED" : "OPEN",
                merged: false,
                isDraft: false,
                mergeable: "MERGEABLE",
              },
            },
          },
        });
      if (query.includes("MergeGates"))
        return json({
          data: {
            repository: {
              ...identity,
              pullRequest: {
                ...pr,
                reviewDecision: null,
                mergeStateStatus: "CLEAN",
                mergeQueue: null,
                mergeQueueEntry: null,
                potentialMergeCommit: null,
              },
            },
          },
        });
      return Response.json({ message: "forbidden" }, { status: 403 });
    }
    if (path === "/repos/org/repo/rules/branches/main") return json([]);
    if (
      method === "GET" &&
      (path.endsWith("/issues/7/comments") ||
        path.endsWith("/pulls/7/reviews")) &&
      onMarkerScan
    ) {
      const hook = onMarkerScan;
      onMarkerScan = undefined;
      await hook();
    }
    if (path.endsWith("/issues/7/comments")) {
      if (method === "GET") return json(replies.map(commentRow));
      if (method === "POST") {
        replies.push(JSON.parse(String(init?.body)).body);
        if (loseNextComment) {
          loseNextComment = false;
          return Response.json({}, { status: 503 });
        }
        return Response.json(commentRow(replies.at(-1)!, replies.length - 1), {
          status: 201,
        });
      }
    }
    if (
      path.startsWith(`/repos/org/repo/compare/${baseSha}...`) &&
      markers.has(path.split("...")[1]!)
    ) {
      const requested = path.split("...")[1]!;
      filesRead.push(requested);
      return json({
        base_commit: { sha: baseSha },
        files: [
          {
            filename: "src/change.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+" + markers.get(requested),
          },
        ],
      });
    }
    if (path.endsWith("/pulls/7/reviews") && method === "GET") return json([]);
    if (path.endsWith("/pulls/7/reviews") && method === "POST") {
      const request = JSON.parse(String(init?.body));
      reviews.push(request);
      if (loseNextReview) {
        loseNextReview = false;
        return Response.json({}, { status: 503 });
      }
      return json({
        id: 22 + reviews.length,
        html_url:
          "https://github.com/org/repo/pull/7#pullrequestreview-" +
          (22 + reviews.length),
        body: request.body,
        commit_id: request.commit_id,
        user: { login: "fixture[bot]" },
        state: "COMMENTED",
      });
    }
    throw Error("Unexpected fixture endpoint " + path);
  };
  const github = new OctokitGitHubClient(
    config,
    key,
    store.activeBinding.bind(store),
    async () => {},
    gitTransport,
    (id) => store.publicationAllowed(id),
    (id) => store.reviewPublicationCurrent(id),
  );
  const resolver = t.mock.method(github, "resolvePullRevision");
  const coordinator = new PullCoordinator(
    store,
    github,
    config.connector,
    (c) => (c === "connector" ? { deviceId: "bridge" } : undefined),
  );
  const server = createChannelServer(
    config,
    store,
    "hook",
    "admin",
    coordinator,
    undefined,
    undefined,
    github.readMergeFacts.bind(github),
    undefined,
    github.reconcileClarification.bind(github),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const journal = new AgentStore(join(dir, "journal.db"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    journal.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown) =>
    fetch(url + "/connector/v2/" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer connector",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const send = async (
    event: string,
    fields: object,
    delivery: string = randomUUID(),
    expectedStatus: number | "decision" = 202,
  ) => {
    const body = JSON.stringify({
      installation: { id: 1 },
      repository: { id: 2, name: "repo", owner: { login: "org" } },
      sender,
      ...fields,
    });
    const res = await fetch(url + "/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          "sha256=" + createHmac("sha256", "hook").update(body).digest("hex"),
      },
      body,
    });
    if (expectedStatus === "decision")
      assert.ok([200, 202].includes(res.status));
    else assert.equal(res.status, expectedStatus);
    return (await res.json()) as { taskId: string; duplicate: boolean };
  };
  const pr = (
    action: "opened" | "synchronize",
    sha: string,
    delivery?: string,
    at?: number,
    status: number | "decision" = 202,
  ) =>
    send(
      "pull_request",
      {
        action,
        pull_request: {
          number: 7,
          title: "Inspect this change",
          body: null,
          state: "open",
          ...(at !== undefined && {
            created_at: new Date(at).toISOString(),
            updated_at: new Date(at).toISOString(),
          }),
          head: { sha, repo: { id: 2 } },
          base: { sha: baseSha, repo: { id: 2 } },
        },
      },
      delivery,
      status,
    );
  const comment = (
    delivery?: string,
    prompt = "@fixture inspect this change",
  ) =>
    send(
      "issue_comment",
      {
        action: "created",
        issue: { number: 7, state: "open", pull_request: {} },
        comment: { id: 8, user: sender, body: prompt },
      },
      delivery,
    );
  const agentWith = (model: typeof fetch, transport: typeof fetch = fetch) => {
    const agentConfig: AgentConfig = {
      channel: { baseUrl: url, tokenEnv: "C" },
      runtime: {
        type: "openclaw",
        agentId: "github",
        baseUrl: "http://127.0.0.1:1",
        tokenEnv: "R",
        timeoutMs: 10_000,
        maxToolRounds: 1,
      },
      stateFile: join(dir, "journal.db"),
      pollIntervalMs: 100,
      requestTimeoutMs: 5000,
    };
    return new Agent(
      agentConfig,
      journal,
      new OpenClawConnector(agentConfig.runtime, "model", model),
      "connector",
      transport,
    );
  };
  return {
    github,
    setReviewerAccess: (allowed: boolean) => {
      reviewerCanWrite = allowed;
    },
    store,
    post,
    push: (sha: string) =>
      send(
        "push",
        { ref: "refs/heads/feature", after: sha, deleted: false },
        randomUUID(),
        200,
      ),
    pr,
    comment,
    agentWith,
    setHead: (sha: string) => {
      head = sha;
    },
    resolver,
    reviews,
    duringMarkerScan(fn: () => Promise<void>) {
      onMarkerScan = fn;
    },
    loseReviewAcknowledgement: () => {
      loseNextReview = true;
    },
    filesRead,
    replies,
    postedAt,
    loseNextComment: () => {
      loseNextComment = true;
    },
    reply: (
      id: number,
      text: string,
      time: number,
      user = sender,
      expected = 202,
      delivery = randomUUID(),
    ) =>
      send(
        "issue_comment",
        {
          sender: user,
          action: "created",
          issue: { number: 7, state: "open", pull_request: {} },
          comment: {
            id,
            user,
            body: text,
            created_at: new Date(time).toISOString(),
          },
        },
        delivery,
        expected,
      ),
    retarget: () => {
      baseRef = "release";
    },
    url,
    closePr: () => {
      closed = true;
    },
    publisher: new DeliveryWorker(store, github),
    database,
  };
}

for (const changed of ["closed", "new_head"] as const) {
  test(
    "a resumed PR keeps its merge snapshot without publishing after " + changed,
    async (t) => {
      const f = await fixture(t);
      let turns = 0;
      const agent = f.agentWith(async () => {
        const first = ++turns === 1;
        assert.ok(turns <= 2, "No model turn after the unpublishable read");
        if (!first) {
          if (changed === "closed") f.closePr();
          else f.setHead(h2);
        }
        return json({
          status: "completed",
          id: "r" + turns,
          output: [
            {
              type: "function_call",
              call_id: "c" + turns,
              name: first ? "request_clarification" : "read_merge_facts",
              arguments: first
                ? JSON.stringify({ question: "Which environment?" })
                : "{}",
            },
          ],
        });
      });
      await f.reply(8, "@fixture inspect this change", f.postedAt - 1000);
      await agent.once();
      await f.publisher.tick();
      const { taskId } = await f.reply(9, "Linux", f.postedAt + 2000);
      await agent.once();
      const stored = f.store.get(taskId)!;
      assert.equal(stored.status, "succeeded");
      assert.equal(stored.deliveryStatus, "skipped");
      assert.equal(stored.publicationReceipt, null);
      assert.match(stored.error ?? "", /merge snapshot/);
      assert.equal(stored.outcome?.artifacts[0]?.name, "merge_assessment");
      assert.ok(
        stored.outcome?.text.includes(
          changed === "closed" ? "已关闭未合并" : h2,
        ),
      );
      assert.equal(await f.publisher.tick(), false);
      assert.equal(f.replies.length, 1);
    },
  );
}

test("a rejected undispatched answer leaves the original question open for a fresh authorized reply", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const agent = f.agentWith(async () => {
    if (++calls === 1)
      return json({
        status: "completed",
        id: "q",
        output: [
          {
            type: "function_call",
            name: "request_clarification",
            call_id: "q1",
            arguments: JSON.stringify({ question: "Which system?" }),
          },
        ],
      });
    return json({
      status: "completed",
      id: "r",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Reviewed Linux." }],
        },
      ],
    });
  });
  const root = (
    await f.reply(8, "@fixture inspect this change", f.postedAt - 2000)
  ).taskId;
  await agent.once();
  await f.publisher.tick();
  f.setReviewerAccess(false);
  const first = await f.reply(11, "Windows", f.postedAt + 1000);
  assert.equal(await agent.once(), false);
  assert.equal(f.store.get(first.taskId)?.status, "rejected");
  assert.equal(f.store.clarificationState(root)?.status, "waiting");
  assert.equal(calls, 1);
  f.setReviewerAccess(true);
  const duplicate = await f.reply(11, "Windows", f.postedAt + 1000);
  assert.equal(duplicate.taskId, first.taskId);
  assert.equal(await agent.once(), false);
  const second = await f.reply(
    12,
    "/answer " + root + " Linux",
    Date.now() + 2000,
  );
  assert.ok(second.taskId && second.taskId !== first.taskId);
  await agent.once();
  await f.publisher.tick();
  assert.equal(f.store.get(second.taskId)?.deliveryStatus, "sent");
  assert.equal(f.store.conversation(first.taskId)?.rootTaskId, root);
  assert.equal(calls, 2);
});

test("an implicit answer delivered during an uncertain question write is only activated after verified readback", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const agent = f.agentWith(async () => {
    assert.equal(++calls, 1);
    return json({
      status: "completed",
      id: "question",
      output: [
        {
          type: "function_call",
          name: "request_clarification",
          call_id: "q",
          arguments: JSON.stringify({ question: "Which browser?" }),
        },
      ],
    });
  });
  const { taskId } = await f.reply(
    8,
    "@fixture check the login screen",
    f.postedAt - 1000,
  );
  await agent.once();
  f.loseNextComment();
  await f.publisher.tick();
  const delivery = randomUUID();
  const early = await f.reply(
    20,
    "Firefox",
    Date.now() + 1000,
    sender,
    200,
    delivery,
  );
  assert.equal(early.taskId, null);
  assert.equal(
    f.store.activityReceipt(delivery)?.reason,
    "clarification_pending",
  );
  assert.equal(await agent.once(), false);
  const reconciled = await fetch(
    f.url + "/tasks/" + taskId + "/reconcile-clarification",
    { method: "POST", headers: { authorization: "Bearer admin" } },
  );
  assert.equal(reconciled.status, 200);
  const answer = f.store.activityReceipt(delivery);
  assert.equal(answer?.reason, "clarification_reply");
  assert.ok(answer?.taskId);
  assert.equal(f.store.get(answer.taskId)?.continuation?.rootTaskId, taskId);
  const conversation = await (
    await fetch(f.url + "/tasks/" + answer.taskId + "/conversation", {
      headers: { authorization: "Bearer admin" },
    })
  ).json();
  assert.equal(conversation.rootTaskId, taskId);
  assert.deepEqual(
    conversation.turns.map((v: { taskId: string }) => v.taskId),
    [taskId, answer.taskId],
  );
  assert.equal(f.replies.length, 1);
});

test("an unmentioned answer resumes the original PR delegation after a verified question, even when the question POST acknowledgement was lost", async (t) => {
  const f = await fixture(t);
  const original = "@fixture inspect this change",
    question = "Which platform reproduces it?",
    answer = "Windows only.";
  let modelRuns = 0;
  const agent = f.agentWith(async (_, init) => {
    const req = JSON.parse(String(init?.body));
    if (++modelRuns === 1) {
      assert.ok(
        req.tools.some(
          (tool: { name: string }) => tool.name === "request_clarification",
        ),
      );
      return json({
        id: "asking",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "request_clarification",
            arguments: JSON.stringify({ question }),
            call_id: "question-1",
          },
        ],
      });
    }
    assert.equal(modelRuns, 2);
    const messages = JSON.stringify(req.input);
    for (const expected of [original, question, answer, "SECOND_ONLY", h2])
      assert.ok(messages.includes(expected), expected);
    return json({
      id: "answering",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Reviewed the Windows path on the updated PR.",
            },
          ],
        },
      ],
    });
  });
  const { taskId: root } = await f.reply(8, original, f.postedAt - 1000);
  await agent.once();
  assert.equal(f.store.get(root)?.outcome?.publication.kind, "clarification");
  f.loseNextComment();
  await f.publisher.tick();
  assert.equal(f.store.get(root)?.deliveryStatus, "unknown");
  assert.equal(f.store.clarificationState(root), null);
  const admin = (action: string, data: object) =>
    fetch(f.url + "/tasks/" + root + "/" + action, {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
  assert.equal(
    (
      await admin("resolve-delivery", {
        confirmedReconciled: true,
        resolution: "sent",
        url: "https://github.com/org/repo/pull/7#issuecomment-999",
      })
    ).status,
    409,
  );
  assert.equal((await admin("reconcile-clarification", {})).status, 200);
  assert.deepEqual(f.store.get(root)?.publicationReceipt, {
    kind: "comment",
    id: 31,
    url: "https://github.com/org/repo/pull/7#issuecomment-31",
    createdAt: f.postedAt,
  });
  assert.match(f.replies[0], new RegExp("/answer " + root));
  assert.equal(f.store.clarificationState(root)?.status, "waiting");
  await f.reply(9, "older discussion", f.postedAt, sender, 200);
  await f.reply(
    10,
    "unrelated discussion",
    f.postedAt + 1000,
    { ...sender, id: 6, login: "bob" },
    200,
  );
  assert.equal(await agent.once(), false);
  f.setHead(h2);
  const { taskId: child } = await f.reply(11, answer, f.postedAt + 2000);
  assert.notEqual(child, root);
  const duplicate = await f.reply(11, answer, f.postedAt + 2000);
  assert.equal(duplicate.taskId, child);
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.store.clarificationState(child)?.rootTaskId, root);
  await agent.once();
  await f.publisher.tick();
  assert.equal(
    f.store.get(child)?.publicationReceipt?.url,
    "https://github.com/org/repo/pull/7#issuecomment-32",
  );
  assert.equal(f.store.get(child)?.outcome?.publication.kind, "comment");
  assert.match(f.replies[1], /Windows/);
  assert.deepEqual(f.filesRead, [h1, h2]);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.replies.length, 2);
  assert.equal(await agent.once(), false);
  assert.equal(await f.publisher.tick(), false);
  assert.equal(modelRuns, 2);
});

test("opened H1 returning after synchronize H2 cannot publish; only H2 produces a commit-bound review receipt", async (t) => {
  const f = await fixture(t);
  const delivery = randomUUID();
  const first = await f.pr("opened", h1, delivery);
  assert.deepEqual(await f.pr("opened", h1, delivery), {
    taskId: first.taskId,
    duplicate: true,
  });
  let secondId: string | undefined;
  const evidenceSeen: string[] = [];
  const agent = f.agentWith(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const evidence = JSON.parse(request.input.at(-1).content);
    evidenceSeen.push(evidence.revision.headSha);
    const marker = evidence.files[0].patch.split("\n+")[1];
    if (evidence.revision.headSha === h1) {
      // The real first Agent has claimed, read H1, and invoked the model. Advance
      // the live PR and admit the signed synchronize while that call is outstanding.
      f.setHead(h2);
      secondId = (await f.pr("synchronize", h2)).taskId;
    }
    return json({
      id: "observed-" + marker,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Observed src/change.ts:1 " + marker },
          ],
        },
      ],
    });
  });
  assert.equal(await agent.once(), true);
  assert.ok(secondId);
  assert.notEqual(first.taskId, secondId);
  assert.deepEqual(f.store.get(first.taskId)?.target, {
    kind: "pull_request",
    number: 7,
    revision: revision(h1),
  });
  assert.match(f.store.get(first.taskId)?.outcome?.text ?? "", /FIRST_ONLY/);
  assert.equal(await f.publisher.tick(), true);
  assert.equal(f.store.get(first.taskId)?.deliveryStatus, "failed");
  assert.equal(f.store.get(first.taskId)?.publicationReceipt, null);
  assert.equal(f.reviews.length, 0);
  assert.equal(await agent.once(), true);
  assert.deepEqual(f.store.get(secondId)?.target, {
    kind: "pull_request",
    number: 7,
    revision: revision(h2),
  });
  assert.equal(await f.publisher.tick(), true);
  assert.deepEqual(f.filesRead, [h1, h2]);
  assert.deepEqual(evidenceSeen, [h1, h2]);
  assert.equal(f.resolver.mock.callCount(), 0);
  assert.deepEqual(
    f.reviews.map((r) => r.commit_id),
    [h2],
  );
  assert.match(f.reviews[0].body, /SECOND_ONLY/);
  assert.doesNotMatch(f.reviews[0].body, /FIRST_ONLY/);
  assert.deepEqual(f.store.get(secondId)?.publicationReceipt, {
    kind: "review",
    id: 23,
    url: reviewUrl,
  });
  assert.equal(await f.publisher.tick(), false);
  assert.equal(await agent.once(), false);
});

for (const native of [true, false]) {
  test(
    "a later signed B blocks an old A after its marker scan without waiting for the returned A webhook: " +
      (native ? "Review" : "comment"),
    async (t) => {
      const f = await fixture(t, false, undefined, native);
      const at = Math.floor(Date.now() / 1000) * 1000 - 10000;
      const first = await f.pr("opened", h1, randomUUID(), at);
      const agent = f.agentWith(async () =>
        json({
          id: "ran-on-old-A",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "old review" }],
            },
          ],
        }),
      );
      await agent.once();
      assert.equal(
        f.store.get(first.taskId)?.outcome?.publication.kind,
        native ? "review" : "comment",
      );
      let injected = false;
      f.duringMarkerScan(async () => {
        // GitHub's PR API has already returned to A, but the only new signed event is B.
        await f.pr("synchronize", h2, randomUUID(), at + 1000);
        injected = true;
      });
      assert.equal(await f.publisher.tick(), true);
      assert.equal(injected, true);
      assert.equal(f.store.get(first.taskId)?.deliveryStatus, "failed");
      assert.equal(f.store.get(first.taskId)?.publicationReceipt, null);
      assert.deepEqual(f.replies, []);
      assert.deepEqual(f.reviews, []);
    },
  );
}
// The head seen on GitHub is the *returned* SHA throughout publication; a
// simple live SHA equality check therefore cannot distinguish the generations.
for (const events of [
  [
    [h2, 2],
    [h1, 4],
    [h1, 3],
  ],
  [
    [h1, 4],
    [h2, 2],
  ],
  [
    [h2, 2],
    [h1, 2],
  ],
] as [string, number][][]) {
  const sameSecond = events[0][1] === events[1][1];
  test(
    "review generation return during execution: " +
      events.map(([s, t]) => s[0] + "@" + t).join(", "),
    async (t) => {
      const f = await fixture(t);
      const start = Math.floor(Date.now() / 1000) * 1000 - 120_000;
      const firstDelivery = randomUUID();
      const first = await f.pr("opened", h1, firstDelivery, start);
      const ids: string[] = [];
      let calls = 0;
      const agent = f.agentWith(async () => {
        if (++calls === 1) {
          for (const [sha, at] of events) {
            const id = randomUUID();
            ids.push(id);
            await f.pr("synchronize", sha, id, start + at * 1000, "decision");
          }
          assert.equal(f.store.get(first.taskId)?.status, "running");
        }
        return json({
          id: "review-" + calls,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "review generation " + calls },
              ],
            },
          ],
        });
      });
      assert.equal(await agent.once(), true);
      assert.equal(f.store.get(first.taskId)?.status, "succeeded");
      const old = f.store.get(first.taskId)!;
      assert.equal(old.deliveryStatus, "skipped");
      assert.equal(old.publicationReceipt, null);
      const candidateIds = events
        .map(([sha], i) =>
          sha === h1 ? f.store.activityReceipt(ids[i])?.taskId : null,
        )
        .filter((id) => id != null);
      if (sameSecond) assert.equal(candidateIds.length, 0);
      else {
        assert.equal(new Set(candidateIds).size, 1);
        assert.notEqual(candidateIds[0], first.taskId);
      }
      // Duplicate each delivery. This must not rearm the fenced execution or
      // manufacture an independent publisher for another same-generation event.
      for (const [i, [sha, at]] of events.entries())
        await f.pr("synchronize", sha, ids[i], start + at * 1000, "decision");
      await f.pr("opened", h1, firstDelivery, start, "decision");
      for (let i = 0; i < events.length + 2; i++) {
        await agent.once();
        await f.publisher.tick();
      }
      assert.equal(calls, sameSecond ? 1 : 2);
      assert.deepEqual(
        f.reviews.map((r) => r.commit_id),
        sameSecond ? [] : [h1],
      );
      assert.equal(f.store.get(first.taskId)?.publicationReceipt, null);
      if (!sameSecond)
        assert.equal(f.store.get(candidateIds[0]!)?.publicationReceipt?.id, 23);
    },
  );
}

test("an uncertain Review POST remains unknown across a signed return, never replayed", async (t) => {
  const f = await fixture(t),
    start = Date.now() - 60000;
  let calls = 0;
  const agent = f.agentWith(async () =>
    json({
      id: "r" + ++calls,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Review" }],
        },
      ],
    }),
  );
  const id = randomUUID(),
    first = await f.pr("opened", h1, id, start);
  await agent.once();
  f.loseReviewAcknowledgement();
  await f.publisher.tick();
  assert.equal(f.store.get(first.taskId)?.deliveryStatus, "unknown");
  await f.pr("synchronize", h2, undefined, start + 1000);
  const next = await f.pr("synchronize", h1, undefined, start + 2000);
  assert.notEqual(next.taskId, first.taskId);
  assert.equal((await f.pr("opened", h1, id, start)).taskId, first.taskId);
  assert.equal(await agent.once(), false);
  assert.equal(await f.publisher.tick(), false);
  assert.equal(f.store.get(first.taskId)?.deliveryStatus, "unknown");
  assert.equal(f.store.get(first.taskId)?.publicationReceipt, null);
  assert.equal(calls, 1);
  assert.deepEqual(
    f.reviews.map((r) => r.commit_id),
    [h1],
  );
});
test("a coalesced intervening event still separates two returns to B without replaying an already published C", async (t) => {
  const f = await fixture(t);
  const start = Math.floor(Date.now() / 1000) * 1000 - 60000;
  let calls = 0;
  const agent = f.agentWith(async () =>
    json({
      id: "r" + ++calls,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Review " + calls }],
        },
      ],
    }),
  );
  f.setHead(h3);
  const c0 = await f.pr("opened", h3, undefined, start);
  await agent.once();
  await f.publisher.tick();
  const sent = f.store.get(c0.taskId)?.publicationReceipt;
  assert.ok(sent);
  const c2id = randomUUID();
  await f.pr("synchronize", h3, c2id, start + 2000, "decision");
  const b1id = randomUUID();
  await f.pr("synchronize", h2, b1id, start + 1000, "decision");
  f.setHead(h2);
  const b3 = await f.pr("synchronize", h2, undefined, start + 3000);
  assert.ok(b3.taskId);
  const oldB = f.store.activityReceipt(b1id)?.taskId;
  assert.notEqual(oldB, b3.taskId);
  await f.pr("synchronize", h3, c2id, start + 2000, "decision");
  for (let i = 0; i < 5; i++) {
    await agent.once();
    await f.publisher.tick();
  }
  assert.deepEqual(
    f.reviews.map((r) => r.commit_id),
    [h3, h2],
  );
  assert.equal(calls, 2);
  assert.equal(f.store.get(b3.taskId)?.publicationReceipt?.id, 24);
  if (oldB) assert.equal(f.store.get(oldB)?.publicationReceipt, null);
  assert.deepEqual(f.store.get(c0.taskId)?.publicationReceipt, sent);
});
test("three rapid PR heads leave scoped lineage for stale runs and only the authorized current head publishes", async (t) => {
  const f = await fixture(t);
  const start = Date.now() - 120000;
  const deliveries = [randomUUID(), randomUUID(), randomUUID()];
  const first = await f.pr("opened", h1, deliveries[0], start);
  let second = "",
    third = "";
  const modelPins: string[] = [];
  const agent = f.agentWith(async (_url, init) => {
    const messages: { role: string; content: string }[] = JSON.parse(
      String(init?.body),
    ).input;
    const evidence = JSON.parse(messages.at(-1)!.content);
    const historical = messages
      .slice(0, -1)
      .find((m) => m.content.startsWith("Prior published review"));
    if ([emptyCommit, rewritten].includes(evidence.revision.headSha)) {
      assert.ok(historical);
      const prior = JSON.parse(
        historical.content.slice(historical.content.indexOf("{")),
      );
      assert.equal(
        prior.revision.headSha,
        evidence.revision.headSha === emptyCommit ? h3 : emptyCommit,
      );
      assert.match(prior.excerpt, /THIRD_ONLY/);
      assert.equal(
        prior.receiptId,
        evidence.revision.headSha === emptyCommit ? 23 : 24,
      );
      assert.equal(prior.inputLimited, false);
      if (evidence.revision.headSha === rewritten)
        assert.doesNotMatch(JSON.stringify(evidence), /THIRD_ONLY/);
    } else assert.equal(historical, undefined);
    modelPins.push(evidence.revision.headSha);
    if (evidence.revision.headSha === h1) {
      f.setHead(h2);
      second = (await f.pr("synchronize", h2, deliveries[1], start + 1000))
        .taskId;
      f.setHead(h3);
      third = (await f.pr("synchronize", h3, deliveries[2], start + 2000))
        .taskId;
      assert.equal(f.store.get(first.taskId)?.status, "running");
      assert.equal((await f.push(h3)).taskId, null);
      assert.deepEqual(
        await f.pr("synchronize", h3, deliveries[2], start + 2000),
        { taskId: third, duplicate: true },
      );
    }
    return json({
      id: "run-" + modelPins.length,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Observed " + evidence.files[0].patch,
            },
          ],
        },
      ],
    });
  });
  assert.equal(await agent.once(), true);
  assert.equal(f.store.get(first.taskId)?.status, "succeeded");
  assert.equal(await f.publisher.tick(), true);
  assert.equal(await agent.once(), false); // H2 failed the claim preflight before any model call.
  assert.equal(f.store.get(second)?.status, "rejected");
  assert.equal(await agent.once(), true);
  assert.equal(await f.publisher.tick(), true);
  assert.deepEqual(modelPins, [h1, h3]);
  assert.deepEqual(f.filesRead, [h1, h3]);
  assert.deepEqual(
    f.reviews.map((r) => r.commit_id),
    [h3],
  );
  assert.match(f.reviews[0].body, /THIRD_ONLY/);
  assert.equal(
    await fetch(f.url + "/tasks/" + first.taskId + "/review-lineage").then(
      (r) => r.status,
    ),
    401,
  );
  for (const [id, delivery, sha] of [
    [first.taskId, deliveries[0], h1],
    [second, deliveries[1], h2],
  ]) {
    const get = async (path: string) => {
      const res = await fetch(f.url + path, {
        headers: { authorization: "Bearer admin" },
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const { reviewLineage, reviewInput } = await get(
      "/tasks/" + id + "/review-lineage",
    );
    assert.deepEqual(reviewLineage.previousRevision, revision(sha));
    assert.deepEqual(reviewLineage.observedRevision, revision(h3));
    assert.equal(reviewLineage.successorTaskId, third);
    assert.deepEqual(
      (await get("/activities/" + delivery)).reviewLineage,
      reviewLineage,
    );
    assert.equal(f.store.get(id)?.publicationReceipt, null);
    if (sha === h1) {
      assert.deepEqual(reviewInput.revision, revision(h1));
      assert.equal(reviewInput.suppliedFiles, 1);
    } else assert.equal(reviewInput, null); // H2 was never disclosed.
  }
  // A new head with identical base-to-head patch is still a different target.
  // The next rewritten head has no supplied ancestry proof: the fixture allows
  // only full pinned comparisons, never a delta from the prior review.
  let previousId = third;
  for (const [i, sha] of [emptyCommit, rewritten].entries()) {
    f.setHead(sha);
    const { taskId } = await f.pr(
      "synchronize",
      sha,
      randomUUID(),
      start + 3000 + i * 1000,
    );
    assert.equal(await agent.once(), true);
    assert.equal(f.store.get(taskId)?.publicationReceipt, null);
    assert.equal(await f.publisher.tick(), true);
    assert.equal(f.store.get(taskId)?.publicationReceipt?.id, 24 + i);
    const result = await fetch(f.url + "/tasks/" + taskId + "/review-lineage", {
      headers: { authorization: "Bearer admin" },
    });
    assert.equal(result.status, 200);
    const { reviewInput, previousPublishedReview } = await result.json();
    assert.deepEqual(reviewInput.revision, revision(sha));
    assert.equal(reviewInput.completePatches, 1);
    assert.equal(previousPublishedReview.taskId, previousId);
    assert.equal(
      previousPublishedReview.reviewInput.revision.headSha,
      i === 0 ? h3 : emptyCommit,
    );
    assert.equal(previousPublishedReview.publicationReceipt.id, 23 + i);
    previousId = taskId;
  }
  assert.deepEqual(f.filesRead, [h1, h3, emptyCommit, rewritten]);
  assert.deepEqual(modelPins, f.filesRead);
  assert.deepEqual(
    f.reviews.map((r) => r.commit_id),
    [h3, emptyCommit, rewritten],
  );
  assert.match(f.reviews[1].body, /THIRD_ONLY/);
  assert.match(f.reviews[2].body, /REWRITTEN_ONLY/);
  assert.doesNotMatch(f.reviews[2].body, /THIRD_ONLY/);
  assert.equal(await agent.once(), false);
  assert.equal(await f.publisher.tick(), false);
});

test("merge question traverses the bridge and scoped GitHub reads; a later closed readback never publishes", async (t) => {
  const f = await fixture(t);
  const { taskId } = await f.comment(undefined, "@fixture is enable merged?");
  const agent = f.agentWith(async () => {
    assert.fail("merge question dispatched a model");
  });
  assert.equal(await agent.once(), true);
  const task = f.store.get(taskId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.runtime?.provider, "channel-merge-assessment");
  assert.deepEqual(task.runtime?.modelTools, []);
  assert.equal(task.outcome?.publication.kind, "comment");
  assert.match(task.outcome!.text, /仍开放未合并/);
  assert.match(task.outcome!.text, /administration:read/);
  assert.deepEqual(f.filesRead, []);
  assert.equal(await f.publisher.tick(), true);
  assert.equal(f.replies.length, 1);
  assert.equal(f.reviews.length, 0);
  const lookup = "/repositories/2/comments/8/task";
  const get = (path: string) =>
    fetch(f.url + path, { headers: { authorization: "Bearer admin" } });
  assert.equal((await fetch(f.url + lookup)).status, 401);
  assert.equal((await get("/repositories/9/comments/8/task")).status, 404);
  const audit = await (await get(lookup)).json();
  assert.equal(audit.id, taskId);
  assert.equal(audit.publicationReceipt.id, 31);
  assert.equal(audit.prompt, undefined);
  assert.deepEqual(
    audit.toolAudit.map((r: { name: string; succeeded: number }) => [
      r.name,
      r.succeeded,
    ]),
    [["read_merge_facts", 1]],
  );
  f.closePr();
  const readback = "/tasks/" + taskId + "/merge-facts";
  assert.equal((await fetch(f.url + readback)).status, 401);
  const current = await (await get(readback)).json();
  assert.equal(current.source, "current_readback");
  assert.equal(current.assessment.state, "closed");
  assert.equal(current.assessment.platform, "not_applicable");
  assert.deepEqual(f.store.get(taskId)?.outcome, task.outcome);
  assert.deepEqual(
    (await (await get(lookup)).json()).toolAudit,
    audit.toolAudit,
  );
  assert.equal(await f.publisher.tick(), false);
  assert.equal(f.replies.length, 1);
});

test("retargeting to a branch at the identical SHA fences a previously assessed reply", async (t) => {
  const f = await fixture(t);
  const { taskId } = await f.comment(undefined, "@fixture /merge-status");
  await f
    .agentWith(async () => {
      assert.fail("model dispatched");
    })
    .once();
  assert.deepEqual(f.store.get(taskId)?.outcome?.publication, {
    kind: "comment",
    expectedBaseRef: "main",
  });
  f.retarget();
  await f.publisher.tick();
  assert.equal(f.replies.length, 0);
  assert.equal(f.store.get(taskId)?.publicationReceipt, null);
});

test("PR comment resolves once at claim, persists the pin and lease hash, and cannot request opt-in deep tools", async (t) => {
  const f = await fixture(t);
  const { taskId } = await f.comment();
  assert.deepEqual(f.store.get(taskId)?.target, {
    kind: "pull_request",
    number: 7,
  });
  f.setHead(h2);
  const claim = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(claim.status, 200);
  const { leaseToken, task } = await claim.json();
  const target = { kind: "pull_request", number: 7, revision: revision(h2) };
  assert.deepEqual(task.target, target);
  const disk = new DatabaseSync(f.database, { readOnly: true });
  try {
    const row = disk
      .prepare(
        "SELECT target,leaseHash FROM tasks JOIN assignments ON assignments.taskId=tasks.id WHERE tasks.id=?",
      )
      .get(taskId)!;
    assert.deepEqual(JSON.parse(String(row.target)), target);
    assert.equal(
      row.leaseHash,
      createHash("sha256").update(leaseToken).digest("hex"),
    );
  } finally {
    disk.close();
  }
  assert.deepEqual(await f.comment(), { taskId, duplicate: true });
  const tool = (name: string, token = leaseToken) =>
    f.post("tasks/" + taskId + "/tool", { leaseToken: token, name, args: {} });
  assert.equal((await tool("read_pull_diff", "x".repeat(64))).status, 409);
  assert.equal((await tool("review_access")).status, 403);
  for (const name of ["read_snapshot", "read_source_grant"])
    assert.equal((await tool(name)).status, 400);
  assert.equal(
    (await f.post("tasks/" + taskId + "/source-grant", { leaseToken })).status,
    403,
  );
  assert.equal((await tool("read_pull_diff")).status, 200);
  f.setHead(h1);
  assert.equal((await tool("read_pull_diff")).status, 403);
  assert.deepEqual(f.store.get(taskId)?.target, target);
  assert.equal(f.resolver.mock.callCount(), 1);
  assert.equal((await f.post("claim", { runtime: fixtureAgent })).status, 204);
});

test("a lost preparatory tool read cannot wedge the device; a lost model response still fences it", async (t) => {
  const f = await fixture(t);
  const first = await f.pr("opened", h1);
  let failedRead = false,
    models = 0;
  const agent = f.agentWith(
    async () => {
      models++;
      throw Error("model response lost");
    },
    async (input, init) => {
      if (!failedRead && String(input).endsWith("/tool")) {
        failedRead = true;
        throw Error("read interrupted");
      }
      return fetch(input, init);
    },
  );
  await agent.once();
  assert.equal(models, 0);
  assert.equal(f.store.get(first.taskId)?.status, "failed");
  assert.match(
    f.store.get(first.taskId)?.error ?? "",
    /preparation_interrupted/,
  );
  f.setHead(h2);
  const second = await f.pr("synchronize", h2);
  await agent.once();
  assert.equal(models, 1);
  assert.equal(f.store.get(second.taskId)?.status, "unknown");
});

test("a newer head before claim records a scoped revision rejection and discloses no assignment", async (t) => {
  const f = await fixture(t);
  const at = Date.now() - 10_000;
  const task = await f.pr("opened", h1, undefined, at);
  f.setHead(h2);
  const response = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(f.store.get(task.taskId)?.error, "pr_revision_changed");
  assert.deepEqual(
    f.store.reviewLineage(task.taskId)?.observedRevision,
    revision(h2),
  );
  assert.equal(f.store.reviewLineage(task.taskId)?.successorTaskId, null);
  const successor = await f.pr("synchronize", h2, undefined, at + 1000);
  assert.equal(
    f.store.reviewLineage(task.taskId)?.successorTaskId,
    successor.taskId,
  );
});

test("only the dedicated grant route releases a credential and never after the assignment expires", async (t) => {
  for (const expire of [false, true]) {
    const f = await fixture(t, true, (store) => {
      if (expire) store.expireTasks(Date.now() + 60000);
    });
    const { taskId } = await f.comment();
    const { leaseToken } = await (
      await f.post("claim", { runtime: fixtureAgent })
    ).json();
    const path = "tasks/" + taskId + "/source-grant";
    assert.equal(
      (await f.post(path, { leaseToken: "z".repeat(64) })).status,
      409,
    );
    assert.equal(
      (await f.post(path, { leaseToken, repositoryId: 99 })).status,
      400,
    );
    const res = await f.post(path, { leaseToken });
    assert.equal(res.status, expire ? 409 : 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    if (expire) assert.doesNotMatch(await res.text(), /synthetic-installation/);
    else assert.equal((await res.json()).token, "synthetic-installation");
  }
});

test("an accepted automatic review without patches delivers one failure notice, not a Review", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.github, "readPullDiff", async () => ({
    untrusted: true,
    revision: revision(h1),
    changedFiles: 1,
    files: [],
    limitations: ["Patch unavailable"],
  }));
  const notices: string[] = [];
  t.mock.method(f.github, "publishComment", async (_task, body: string) => {
    notices.push(body);
    return {
      id: 17,
      url: "https://github.com/org/repo/pull/7#issuecomment-17",
    };
  });
  const started = await f.pr("opened", h1);
  let calls = 0;
  const agent = f.agentWith(async () => {
    calls++;
    throw Error("No model expected");
  });
  assert.equal(await agent.once(), true);
  assert.equal(await f.publisher.tick(), true);
  assert.equal(await f.publisher.tick(), false);
  const task = f.store.get(started.taskId)!;
  assert.equal(calls, 0);
  assert.equal(task.status, "failed");
  assert.match(task.error!, /review_diff_unavailable/);
  assert.equal(task.outcome, null);
  assert.equal(task.deliveryStatus, "sent");
  assert.equal(task.publicationReceipt?.kind, "comment");
  assert.equal(f.reviews.length, 0);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes(h1));
  assert.match(notices[0], /代码评审未完成/);
});

test("a gateway timeout during a pinned file read yields one failure comment, not a Review", async (t) => {
  const f = await fixture(t, false, undefined, false);
  const { taskId } = await f.pr("opened", h1);
  let timeouts = 0;
  const notices: string[] = [];
  t.mock.method(f.github, "publishComment", async (_task, body: string) => {
    notices.push(body);
    return {
      id: 19,
      url: "https://github.com/org/repo/pull/7#issuecomment-19",
    };
  });
  const agent = f.agentWith(
    async () =>
      json({
        status: "completed",
        id: "r1",
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/example.ts" }),
          },
        ],
      }),
    async (input, init) => {
      if (
        String(input).endsWith("/tool") &&
        JSON.parse(String(init?.body)).name === "read_file"
      ) {
        timeouts++;
        return new Response(null, { status: 504 });
      }
      return fetch(input, init);
    },
  );
  await agent.once();
  assert.equal(timeouts, 1);
  assert.equal(await f.publisher.tick(), true);
  assert.equal(await f.publisher.tick(), false);
  assert.equal(f.store.get(taskId)?.status, "failed");
  assert.equal(f.store.get(taskId)?.deliveryStatus, "sent");
  assert.equal(f.store.get(taskId)?.publicationReceipt?.kind, "comment");
  assert.equal(f.reviews.length, 0);
  assert.equal(notices.length, 1);
  assert.ok(
    notices[0].includes(taskId) && notices[0].includes("tool_call_failed"),
  );
});
