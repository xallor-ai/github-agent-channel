import { seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createChannelServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";
import { DeliveryWorker } from "../src/worker.js";
import type { ChannelConfig } from "../src/contracts.js";
const cfg: ChannelConfig = {
  server: { host: "127.0.0.1", port: 8080, adminTokenEnv: "ADMIN" },
  dataFile: ":memory:",
  github: {
    appId: "1",
    privateKeyEnv: "KEY",
    webhookSecretEnv: "SECRET",
    botLogin: "channel[bot]",
  },
  connector: { timeoutMs: 100 },
};
test("PR comment reconciliation accepts pull path and rejects unrelated paths", async () => {
  const s = new TaskStore(":memory:");
  seedBinding(
    s,
    { installationId: 1, repositoryId: 2, owner: "org", repo: "repo" },
    "worker",
  );
  const server = createChannelServer(cfg, s, "secret", "admin");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const task = s.accept({
    deliveryId: "pr",
    source: { event: "issue_comment", action: "created", commentId: 1 },
    bindingId: "1:2:worker:1",
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
    actorId: 3,
    actorLogin: "alice",
    target: { kind: "pull_request", number: 5 },
    prompt: "review",
  }).task;
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/tasks/${task.id}/resolve-delivery`;
  try {
    s.claimAssignment("worker", "hash", Date.now() + 60000);
    s.finishAssignment(
      task.id,
      "worker",
      "hash",
      {
        status: "succeeded",
        outcome: {
          text: "answer",
          artifacts: [],
          publication: { kind: "comment" },
        },
      },
      "digest",
    );
    s.pendingDelivery();
    s.markDelivery(task.id, "unknown");
    for (const path of [
      "/org/repo/pulls/5",
      "/org/repo/discussions/5",
      "/org/repo/pull/6",
      "/org/other/pull/5",
      "/org/repo/pull/5/files",
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer admin" },
        body: JSON.stringify({
          confirmedReconciled: true,
          resolution: "sent",
          url: `https://github.com${path}#issuecomment-123`,
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(s.get(task.id)?.deliveryStatus, "unknown");
    }
    const url = "https://github.com/org/repo/pull/5#issuecomment-123";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer admin" },
      body: JSON.stringify({
        confirmedReconciled: true,
        resolution: "sent",
        url,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(s.get(task.id)?.publicationReceipt?.url, url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.close();
  }
});
test("execution resolution rejects malformed and extra JSON fields without changing unknown state", async () => {
  const s = new TaskStore(":memory:");
  seedBinding(
    s,
    { installationId: 1, repositoryId: 2, owner: "org", repo: "repo" },
    "worker",
  );
  const server = createChannelServer(cfg, s, "secret", "admin");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const task = s.accept({
    deliveryId: "unknown",
    source: { event: "issue_comment", action: "created", commentId: 1 },
    bindingId: "1:2:worker:1",
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
    actorId: 3,
    actorLogin: "alice",
    target: { kind: "issue", number: 5 },
    prompt: "review",
  }).task;
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/tasks/${task.id}/resolve`;
  try {
    s.claimAssignment("worker", "hash", Date.now() + 60000);
    s.finishAssignment(
      task.id,
      "worker",
      "hash",
      { status: "unknown" },
      "digest",
    );
    for (const raw of [
      "{",
      "null",
      "[]",
      "{}",
      JSON.stringify({
        confirmedStopped: true,
        resolution: "failed",
        extra: true,
      }),
      JSON.stringify({ confirmedStopped: "true", resolution: "failed" }),
      JSON.stringify({ confirmedStopped: true, resolution: "succeeded" }),
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer admin" },
        body: raw,
      });
      assert.equal(response.status, 400);
      assert.equal(s.get(task.id)?.status, "unknown");
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer admin" },
      body: JSON.stringify({ confirmedStopped: true, resolution: "failed" }),
    });
    assert.equal(response.status, 200);
    assert.equal(s.get(task.id)?.status, "failed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.close();
  }
});
test("delivery reconciliation requires admin, explicit confirmation and a target-scoped comment URL", async () => {
  const s = new TaskStore(":memory:");
  seedBinding(
    s,
    { installationId: 1, repositoryId: 2, owner: "org", repo: "repo" },
    "worker",
  );
  const server = createChannelServer(cfg, s, "secret", "admin");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const task = s.accept({
    deliveryId: "one",
    source: { event: "issue_comment", action: "created", commentId: 1 },
    bindingId: "1:2:worker:1",
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
    actorId: 3,
    actorLogin: "alice",
    target: { kind: "issue", number: 5 },
    prompt: "review",
  }).task;
  const endpoint = base + "/tasks/" + task.id + "/resolve-delivery";
  const post = (data: unknown, auth = true) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { Authorization: "Bearer admin" } : {}),
      },
      body: JSON.stringify(data),
    });
  try {
    s.claimAssignment("worker", "hash", Date.now() + 60000);
    s.finishAssignment(
      task.id,
      "worker",
      "hash",
      {
        status: "succeeded",
        outcome: {
          text: "answer",
          artifacts: [],
          publication: { kind: "comment" },
        },
      },
      "digest",
    );
    s.pendingDelivery();
    s.markDelivery(task.id, "unknown");
    const valid = {
      confirmedReconciled: true,
      resolution: "sent",
      url: "https://github.com/org/repo/issues/5#issuecomment-123",
    };
    assert.equal((await post(valid, false)).status, 401);
    for (const invalid of [
      null,
      {},
      { ...valid, confirmedReconciled: false },
      { ...valid, resolution: "pending" },
      { ...valid, resolution: ["sent"] },
      { ...valid, url: undefined },
      { ...valid, extra: "ignored" },
      ...[
        "http://github.com/org/repo/issues/5#issuecomment-123",
        "https://evil.test/org/repo/issues/5#issuecomment-123",
        "https://github.com/other/repo/issues/5#issuecomment-123",
        "https://github.com/org/repo/issues/6#issuecomment-123",
        "https://user:pass@github.com/org/repo/issues/5#issuecomment-123",
        "https://github.com/org/repo/issues/5?x=1#issuecomment-123",
        "https://github.com/org/repo/issues/5#issuecomment-no",
      ].map((url) => ({ ...valid, url })),
    ]) {
      assert.equal((await post(invalid)).status, 400);
      assert.equal(s.get(task.id)?.deliveryStatus, "unknown");
    }
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal((await post(valid)).status, 200);
    assert.equal(s.get(task.id)?.publicationReceipt?.url, valid.url);
    assert.equal(s.pendingDelivery(), undefined);
    assert.equal((await post(valid)).status, 409);
    const second = s.accept({
      ...task,
      deliveryId: "two",
      source: { ...task.source, commentId: 2 },
    }).task;
    s.claimAssignment("worker", "hash", Date.now() + 60000);
    s.finishAssignment(
      second.id,
      "worker",
      "hash",
      {
        status: "succeeded",
        outcome: {
          text: "answer",
          artifacts: [],
          publication: { kind: "comment" },
        },
      },
      "digest",
    );
    s.pendingDelivery();
    s.markDelivery(second.id, "unknown");
    const failed = await fetch(
      base + "/tasks/" + second.id + "/resolve-delivery",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          confirmedReconciled: true,
          resolution: "failed",
        }),
      },
    );
    assert.equal(failed.status, 200);
    assert.equal(s.get(second.id)?.deliveryStatus, "failed");
    assert.equal(s.pendingDelivery(), undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.close();
  }
});
test("signed HTTP delivery is persisted and independently completed; task query requires auth", async () => {
  const s = new TaskStore(":memory:");
  seedBinding(
    s,
    { installationId: 1, repositoryId: 2, owner: "org", repo: "repo" },
    "worker",
  );
  const server = createChannelServer(cfg, s, "secret", "admin");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const data = JSON.stringify({
      action: "created",
      installation: { id: 1 },
      repository: { id: 2, name: "repo", owner: { login: "org" } },
      sender: { id: 3, login: "alice", type: "User" },
      comment: {
        id: 4,
        body: "@channel[bot] review this",
        user: { id: 3, login: "alice", type: "User" },
      },
      issue: { number: 5, state: "open" },
    });
    const headers = {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", "secret").update(data).digest("hex"),
    };
    const response = await fetch(base + "/webhooks/github", {
      method: "POST",
      headers,
      body: data,
    });
    assert.equal(response.status, 202);
    const receipt: any = await response.json();
    assert.equal(s.get(receipt.taskId)?.status, "queued");
    const replay = await fetch(base + "/webhooks/github", {
      method: "POST",
      headers,
      body: data,
    });
    assert.equal(((await replay.json()) as any).taskId, receipt.taskId);
    assert.equal((await fetch(base + "/tasks/" + receipt.taskId)).status, 401);
    let published = "";
    s.claimAssignment("worker", "hash", Date.now() + 60000);
    s.finishAssignment(
      receipt.taskId,
      "worker",
      "hash",
      {
        status: "succeeded",
        outcome: {
          text: "review done",
          artifacts: [],
          publication: { kind: "comment" },
        },
      },
      "digest",
    );
    const worker = new DeliveryWorker(s, {
      authorize: async () => {},
      readIssue: async () => ({}),
      readFile: async () => ({}),
      publishPullRequest: async () => {
        throw new Error("Unexpected PR publication");
      },
      publishComment: async (_, text) => {
        published = text;
        return { id: 6, url: "https://github.com/comment/6" };
      },
    });
    await worker.tick();
    await worker.tick();
    assert.equal(published, "review done");
    const status: any = await (
      await fetch(base + "/tasks/" + receipt.taskId, {
        headers: { Authorization: "Bearer admin" },
      })
    ).json();
    assert.equal(status.status, "succeeded");
    assert.equal(status.deliveryStatus, "sent");
    assert.deepEqual(status.target, { kind: "issue", number: 5 });
    assert.deepEqual(status.source, {
      event: "issue_comment",
      action: "created",
      commentId: 4,
    });
    assert.deepEqual(status.outcome, {
      text: "review done",
      artifacts: [],
      publication: { kind: "comment" },
    });
    assert.deepEqual(status.publicationReceipt, {
      kind: "comment",
      id: 6,
      url: "https://github.com/comment/6",
    });
    assert.equal(status.runtime, null);
    assert.equal(status.prompt, undefined);
    assert.equal(
      (
        await fetch(base + "/webhooks/github", {
          method: "POST",
          headers: { ...headers, "x-hub-signature-256": "invalid" },
          body: data,
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.close();
  }
});
test("unknown Review reconciliation needs matching GitHub read-back and never accepts a comment URL", async (t) => {
  const s = new TaskStore(":memory:");
  t.after(() => s.close());
  seedBinding(
    s,
    { installationId: 1, repositoryId: 2, owner: "org", repo: "repo" },
    "worker",
    ["pull_request.opened"],
  );
  const url = "https://github.com/org/repo/pull/5#pullrequestreview-8";
  let verified = false,
    reads = 0;
  const server = createChannelServer(
    cfg,
    s,
    "secret",
    "admin",
    undefined,
    undefined,
    async (_, id) => {
      reads++;
      if (!verified) throw Error("Review identity mismatch");
      return { id, url };
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const task = s.accept({
    deliveryId: "native",
    source: { event: "pull_request", action: "opened" },
    bindingId: "1:2:worker:1",
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
    actorId: 3,
    actorLogin: "alice",
    target: {
      kind: "pull_request",
      number: 5,
      revision: {
        baseSha: "b".repeat(40),
        headSha: "a".repeat(40),
        baseRepoId: 2,
        headRepoId: 2,
      },
    },
    prompt: "review",
  }).task;
  s.claimAssignment("worker", "hash", Date.now() + 60000);
  s.finishAssignment(
    task.id,
    "worker",
    "hash",
    {
      status: "succeeded",
      outcome: {
        text: "summary",
        artifacts: [],
        publication: { kind: "review" },
      },
    },
    "digest",
  );
  s.pendingDelivery();
  s.markDelivery(task.id, "unknown");
  const post = (value: string) =>
    fetch(
      `http://127.0.0.1:${address.port}/tasks/${task.id}/resolve-delivery`,
      {
        method: "POST",
        headers: { Authorization: "Bearer admin" },
        body: JSON.stringify({
          confirmedReconciled: true,
          resolution: "sent",
          url: value,
        }),
      },
    );
  for (const bad of [
    url.replace("pullrequestreview", "issuecomment"),
    url.replace("/5#", "/7#"),
    url + "0".repeat(24),
  ])
    assert.equal((await post(bad)).status, 400);
  assert.equal(reads, 0);
  assert.equal((await post(url)).status, 409);
  assert.equal(s.get(task.id)?.deliveryStatus, "unknown");
  verified = true;
  assert.equal((await post(url)).status, 200);
  assert.deepEqual(s.get(task.id)?.publicationReceipt, {
    kind: "review",
    id: 8,
    url,
  });
});
