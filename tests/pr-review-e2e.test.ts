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
  h2 = "2".repeat(40);
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
      nativeReview: true,
      deepReview,
      events: [
        "pull_request.opened",
        "pull_request.synchronize",
        "issue_comment.created",
      ],
    },
  );
  let head = h1;
  let closed = false;
  const replies: string[] = [];
  const reviews: { commit_id: string; body: string }[] = [];
  const filesRead: string[] = [];
  const gitTransport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname,
      method = init?.method ?? "GET";
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
      return json({ permission: "write", user: sender });
    if (path.endsWith("/pulls/7"))
      return json({
        number: 7,
        state: closed ? "closed" : "open",
        merged: false,
        changed_files: 1,
        base: { sha: baseSha, repo: { id: 2 } },
        head: { sha: head, repo: { id: 2 } },
      });
    if (path === "/graphql") {
      const { query } = JSON.parse(String(init?.body));
      const identity = { databaseId: 2, nameWithOwner: "org/repo" };
      const pr = {
        number: 7,
        baseRefName: "main",
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
    if (path.endsWith("/issues/7/comments")) {
      if (method === "GET") return json([]);
      if (method === "POST") {
        replies.push(JSON.parse(String(init?.body)).body);
        return json({
          id: 31,
          html_url: "https://github.com/org/repo/pull/7#issuecomment-31",
        });
      }
    }
    if (
      [h1, h2].some(
        (sha) => path === `/repos/org/repo/compare/${baseSha}...${sha}`,
      )
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
            patch:
              "@@ -0,0 +1 @@\n+" +
              (requested === h1 ? "FIRST_ONLY" : "SECOND_ONLY"),
          },
        ],
      });
    }
    if (path.endsWith("/pulls/7/reviews") && method === "GET") return json([]);
    if (path.endsWith("/pulls/7/reviews") && method === "POST") {
      const request = JSON.parse(String(init?.body));
      reviews.push(request);
      return json({
        id: 23,
        html_url: reviewUrl,
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
    assert.equal(res.status, 202);
    return (await res.json()) as { taskId: string; duplicate: boolean };
  };
  const pr = (
    action: "opened" | "synchronize",
    sha: string,
    delivery?: string,
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
          head: { sha, repo: { id: 2 } },
          base: { sha: baseSha, repo: { id: 2 } },
        },
      },
      delivery,
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
    store,
    post,
    pr,
    comment,
    agentWith,
    setHead: (sha: string) => {
      head = sha;
    },
    resolver,
    reviews,
    filesRead,
    replies,
    url,
    closePr: () => {
      closed = true;
    },
    publisher: new DeliveryWorker(store, github),
    database,
  };
}

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
  const task = await f.pr("opened", h1);
  f.setHead(h2);
  const response = await f.post("claim", { runtime: fixtureAgent });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(f.store.get(task.taskId)?.error, "pr_revision_changed");
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
