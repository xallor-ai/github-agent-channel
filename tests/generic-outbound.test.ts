import { fixtureAgent } from "./binding-fixture.js";
import { createHmac, randomUUID } from "node:crypto";
import { seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent } from "../src/agent.js";
import { AgentStore } from "../src/agent-store.js";
import { TaskStore } from "../src/store.js";
import { PullCoordinator } from "../src/pull.js";
import { DeliveryWorker } from "../src/worker.js";
import { createChannelServer } from "../src/server.js";
import type {
  RuntimeConnector,
  GitHubClient,
  ChannelConfig,
} from "../src/contracts.js";
const input = {
  deliveryId: "d",
  bindingId: "1:2:worker:1",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "alice",
  prompt: "task",
  source: { event: "issues", action: "opened" },
  target: { kind: "issue" as const, number: 5 },
};
async function fixture(t: any, runtime: RuntimeConnector) {
  const cloud = new TaskStore(":memory:");
  seedBinding(cloud, input, "worker", [
    "issues.opened",
    "push",
    "issue_comment.created",
  ]);
  const local = new AgentStore(":memory:");
  let comments = 0,
    prs = 0;
  const github: GitHubClient = {
    authorize: async () => {},
    readIssue: async () => ({ title: "fixture" }),
    readFile: async () => ({ content: "fixture" }),
    publishComment: async () => {
      comments++;
      return {
        id: 1,
        url: "https://github.com/org/repo/issues/5#issuecomment-1",
      };
    },
    publishPullRequest: async (task, request) => {
      assert.equal(task.repositoryId, 2);
      assert.equal(request.files[0].path, "src/a.txt");
      prs++;
      return { id: 7, url: "https://github.com/org/repo/pull/7" };
    },
  };
  const coordinator = new PullCoordinator(
    cloud,
    github,
    { timeoutMs: 60000 },
    (credential) =>
      credential === "connector" ? { deviceId: "worker" } : undefined,
  );
  const server = createChannelServer(
    { github: { botLogin: "fixture[bot]" } } as ChannelConfig,
    cloud,
    "webhook",
    "admin",
    coordinator,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const agent = new Agent(
    {
      channel: { baseUrl: base, tokenEnv: "TOKEN" },
      runtime: {
        type: "openclaw",
        baseUrl: "http://localhost",
        agentId: "github",
        tokenEnv: "RUNTIME",
        timeoutMs: 10000,
        maxToolRounds: 2,
      },
      stateFile: ":memory:",
      pollIntervalMs: 100,
      requestTimeoutMs: 3000,
    },
    local,
    runtime,
    "connector",
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    cloud.close();
    local.close();
  });
  return {
    cloud,
    local,
    agent,
    base,
    worker: new DeliveryWorker(cloud, github),
    counts: () => ({ comments, prs }),
    post: async (path: string, body: unknown) =>
      fetch(base + "/connector/v2/" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer connector",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  };
}
test("a signed push is observable without a model call or publication", async (t) => {
  let runs = 0;
  const f = await fixture(t, {
    run: async () => {
      runs++;
      throw new Error("Repository push must not invoke the runtime");
    },
  });
  const raw = JSON.stringify({
    installation: { id: 1 },
    repository: { id: 2, name: "repo", owner: { login: "org" } },
    sender: { type: "User", id: 3, login: "alice" },
    ref: "refs/heads/main",
    after: "a".repeat(40),
    deleted: false,
  });
  const response = await fetch(f.base + "/webhooks/github", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", "webhook").update(raw).digest("hex"),
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    observed: true,
    duplicate: false,
    taskId: null,
    reason: "observed",
  });
  await f.agent.once();
  assert.equal(runs, 0);
  assert.equal(await f.worker.tick(), false);
  assert.deepEqual(f.counts(), { comments: 0, prs: 0 });
});
// Direct store admission below exercises the runtime's repository-target protocol independent of webhook activation.
test("repository-target artifacts traverse real outbound HTTP without creating an issue comment", async (t) => {
  const f = await fixture(t, {
    run: async (task, _invoke, _signal, onEvent) => {
      assert.equal(task.target?.kind, "repository");
      await onEvent?.({
        kind: "started",
        runId: "acp-session-1",
        provider: "acp",
      });
      return {
        text: "",
        publication: { kind: "none" },
        artifacts: [{ kind: "text", name: "report", text: "push inspected" }],
      };
    },
  });
  const task = f.cloud.accept({
    ...input,
    source: { event: "push" },
    target: { kind: "repository", sha: "a".repeat(40) },
  }).task;
  assert.equal(await f.agent.once(), true);
  const result = f.cloud.get(task.id)!;
  assert.equal(result.status, "succeeded");
  assert.equal(result.deliveryStatus, "skipped");
  assert.equal(result.outcome?.artifacts?.[0].kind, "text");
  const status = (await fetch(f.base + "/tasks/" + task.id, {
    headers: { authorization: "Bearer admin" },
  }).then((r) => r.json())) as any;
  assert.equal(status.runtime?.runId, "acp-session-1");
  assert.equal(await f.worker.tick(), false);
  assert.deepEqual(f.counts(), { comments: 0, prs: 0 });
});
test("typed PR outcome is delivered once and stored separately from comment receipt", async (t) => {
  const proposal = {
    kind: "pull_request" as const,
    title: "Fix",
    body: "Fix issue",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    files: [{ path: "src/a.txt", content: "new" }],
  };
  const f = await fixture(t, {
    run: async () => ({
      text: "Actual changes",
      publication: proposal,
      artifacts: [
        {
          kind: "test_report",
          name: "unit",
          command: "node --test",
          exitCode: 0,
          summary: "1 passed",
        },
      ],
    }),
  });
  const task = f.cloud.accept({
    ...input,
    target: { kind: "issue", number: 5 },
    source: { event: "issues", action: "opened" },
  }).task;
  await f.agent.once();
  assert.equal(f.cloud.get(task.id)?.status, "succeeded");
  assert.equal(await f.worker.tick(), true);
  assert.equal(await f.worker.tick(), false);
  assert.deepEqual(f.counts(), { comments: 0, prs: 1 });
  assert.equal(
    f.cloud.get(task.id)?.publicationReceipt?.url,
    "https://github.com/org/repo/pull/7",
  );
  assert.equal(f.cloud.get(task.id)?.publicationReceipt?.kind, "pull_request");
});
test("structured result replay is canonical and cannot add identity overrides", async (t) => {
  const f = await fixture(t, {
    run: async () => ({
      text: "unused",
      artifacts: [],
      publication: { kind: "none" },
    }),
  });
  const task = f.cloud.accept({
    ...input,
    source: { event: "issue_comment", action: "created", commentId: 4 },
  }).task;
  const lease = (await f
    .post("claim", { runtime: fixtureAgent })
    .then((r) => r.json())) as any;
  const body = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    outcome: {
      text: "result",
      artifacts: [{ kind: "text", name: "report", text: "ok" }],
      publication: { kind: "none" },
    },
  };
  assert.equal(
    (await f.post("tasks/" + task.id + "/result", { ...body, owner: "evil" }))
      .status,
    400,
  );
  const first = await f.post("tasks/" + task.id + "/result", body);
  assert.equal(first.status, 200);
  const duplicate = await f.post("tasks/" + task.id + "/result", {
    outcome: {
      publication: { kind: "none" },
      artifacts: [{ text: "ok", name: "report", kind: "text" }],
      text: "result",
    },
    status: "succeeded",
    leaseToken: lease.leaseToken,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(((await duplicate.json()) as any).duplicate, true);
  assert.equal(
    (
      await f.post("tasks/" + task.id + "/result", {
        ...body,
        outcome: {
          ...body.outcome,
          artifacts: [{ kind: "text", name: "report", text: "different" }],
        },
      })
    ).status,
    409,
  );
});
test("PR reconciliation requires the exact repository including dots", async (t) => {
  const f = await fixture(t, {
    run: async () => ({
      text: "unused",
      artifacts: [],
      publication: { kind: "none" },
    }),
  });
  const target = { ...input, repositoryId: 3, repo: "foo.bar" };
  const binding = seedBinding(f.cloud, target, "worker", ["issues.opened"]);
  const task = f.cloud.accept({ ...target, bindingId: binding.id }).task;
  f.cloud.claimAssignment("worker", "hash", Date.now() + 60000);
  f.cloud.finishAssignment(
    task.id,
    "worker",
    "hash",
    {
      status: "succeeded",
      outcome: {
        text: "changes",
        artifacts: [],
        publication: {
          kind: "pull_request",
          title: "Fix",
          body: "Fix",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          files: [{ path: "src/a.txt", content: "new" }],
        },
      },
    },
    "digest",
  );
  f.cloud.pendingDelivery();
  f.cloud.markDelivery(task.id, "unknown");
  const reconcile = (repo: string) =>
    fetch(f.base + "/tasks/" + task.id + "/resolve-delivery", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmedReconciled: true,
        resolution: "sent",
        url: "https://github.com/org/" + repo + "/pull/7",
      }),
    });
  assert.equal((await reconcile("fooXbar")).status, 400);
  assert.equal(f.cloud.get(task.id)?.deliveryStatus, "unknown");
  assert.equal((await reconcile("foo.bar")).status, 200);
});
