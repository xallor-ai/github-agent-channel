import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createChannelServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";
import { seedBinding } from "./binding-fixture.js";

test("signed ordinary comment is acknowledged after persistence, visible to admins and in the next task's thread", async (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  seedBinding(
    store,
    { owner: "org", repo: "repo", installationId: 1, repositoryId: 2 },
    "device",
  );
  const server = createChannelServer(
    {
      github: { appId: "1", botLogin: "channel[bot]" },
      connector: { timeoutMs: 1000 },
      dataFile: ":memory:",
      server: { host: "localhost", port: 0 },
    },
    store,
    "hook",
    "admin",
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const comment = async (deliveryId: string, id: number, body: string) => {
    const actor = { type: "User", login: "alice", id: 4 };
    const payload = JSON.stringify({
      installation: { id: 1 },
      repository: { id: 2, owner: { login: "org" }, name: "repo" },
      sender: actor,
      action: "created",
      issue: { number: 5, state: "open" },
      comment: { user: actor, id, body },
    });
    return fetch(origin + "/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", "hook").update(payload).digest("hex"),
      },
      body: payload,
    });
  };
  const first = randomUUID();
  const observed = await comment(first, 1, "Consider reader permissions");
  assert.equal(observed.status, 200);
  assert.deepEqual(await observed.json(), {
    observed: true,
    reason: "observed",
    taskId: null,
    duplicate: false,
  });
  assert.equal(
    store.claimAssignment("device", "lease", Date.now() + 1000),
    undefined,
  );
  const path = origin + "/activities/" + first;
  assert.equal((await fetch(path)).status, 401);
  const headers = { authorization: "Bearer admin" };
  const receipt = await (await fetch(path, { headers })).json();
  assert.equal(receipt.activity.excerpt, "Consider reader permissions");
  assert.equal(receipt.reason, "observed");
  const delegated = await comment(randomUUID(), 2, "@channel review this");
  assert.equal(delegated.status, 202);
  const task = await delegated.json();
  const thread = await (
    await fetch(origin + "/tasks/" + task.taskId + "/thread", { headers })
  ).json();
  assert.equal(thread.activities.length, 1);
  assert.equal(thread.activities[0].deliveryId, first);
});

test("signed bot and filtered closure events fence queued tasks without exposing activity", async (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  seedBinding(
    store,
    { owner: "org", repo: "repo", installationId: 1, repositoryId: 2 },
    "device",
    ["issue_comment.created", "pull_request.closed"],
  );
  const server = createChannelServer(
    {
      github: { appId: "1", botLogin: "channel[bot]" },
      connector: { timeoutMs: 1000 },
      dataFile: ":memory:",
      server: { host: "localhost", port: 0 },
    },
    store,
    "hook",
    "admin",
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const alice = { type: "User", login: "alice", id: 4 };
  const repository = { id: 2, owner: { login: "org" }, name: "repo" };
  const post = async (event: string, deliveryId: string, data: object) => {
    const payload = JSON.stringify({
      installation: { id: 1 },
      repository,
      sender: alice,
      ...data,
    });
    return fetch(origin + "/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", "hook").update(payload).digest("hex"),
      },
      body: payload,
    });
  };
  const createdAt = "2026-11-25T00:00:00Z";
  const closedAt = "2026-11-26T00:00:00Z";
  for (const pull of [false, true]) {
    const number = pull ? 6 : 5;
    const open = {
      number,
      state: "open",
      ...(pull ? { pull_request: {} } : {}),
    };
    const delegate = (id: number, time: string) =>
      post("issue_comment", randomUUID(), {
        action: "created",
        issue: open,
        comment: { user: alice, id, body: "@channel review", created_at: time },
      });
    const delegated = await delegate(number, createdAt);
    assert.equal(delegated.status, 202);
    const { taskId } = await delegated.json();
    const deliveryId = randomUUID();
    const closed = {
      number,
      state: "closed",
      closed_at: closedAt,
      title: "Internal closure",
      body: "Excluded payload",
    };
    const closure = await post(pull ? "pull_request" : "issues", deliveryId, {
      action: "closed",
      ...(pull
        ? {
            sender: { id: 7, type: "Bot", login: "merge-queue[bot]" },
            pull_request: {
              ...closed,
              merged: true,
              base: { sha: "a".repeat(40), repo: repository },
              head: { sha: "b".repeat(40), repo: null },
            },
          }
        : { issue: closed }),
    });
    assert.equal(closure.status, 200);
    assert.deepEqual(await closure.json(), { ignored: true });
    assert.equal(store.get(taskId)?.status, "rejected");
    assert.equal(store.activityReceipt(deliveryId), undefined);

    const delayed = await delegate(number + 100, createdAt);
    assert.equal(delayed.status, 200);
    assert.equal((await delayed.json()).reason, "closed");
    const reopened = await delegate(number + 200, "2026-11-27T00:00:00Z");
    assert.equal(reopened.status, 202);
  }
});
