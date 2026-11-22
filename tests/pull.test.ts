import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createChannelServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";
import { PullCoordinator } from "../src/pull.js";
import { DeliveryWorker } from "../src/worker.js";
import {
  AccessDenied,
  type GitHubClient,
  type NewTask,
  type ChannelConfig,
} from "../src/contracts.js";
const input: NewTask = {
  deliveryId: "d1",
  commentId: 1,
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "user",
  issueNumber: 4,
  prompt: "secret issue prompt",
};
async function fixture(t: test.TestContext, timeoutMs = 60000) {
  const store = new TaskStore(":memory:");
  let authorized = true,
    authorizations = 0,
    reads = 0,
    publications = 0;
  const github: GitHubClient = {
    authorize: async () => {
      authorizations++;
      if (!authorized) throw new AccessDenied();
    },
    readIssue: async (task) => {
      reads++;
      return { title: task.owner + "/" + task.repo, untrusted: true };
    },
    readFile: async () => ({ content: "file" }),
    publish: async () => {
      publications++;
      return {
        id: 1,
        url: "https://github.com/org/repo/issues/4#issuecomment-1",
      };
    },
  };
  const coordinator = new PullCoordinator(
    store,
    github,
    { workerId: "only-worker", timeoutMs },
    "connector-token",
  );
  const config: ChannelConfig = {
    server: { host: "127.0.0.1", port: 0, adminTokenEnv: "ADMIN" },
    dataFile: ":memory:",
    github: {
      appId: "1",
      botLogin: "test[bot]",
      privateKeyEnv: "KEY",
      webhookSecretEnv: "HOOK",
    },
    connector: { workerId: "only-worker", tokenEnv: "CONNECTOR", timeoutMs },
    bindings: [],
  };
  const server = createChannelServer(
    config,
    store,
    "webhook-token",
    "admin-token",
    coordinator,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const post = (path: string, body: unknown, token = "connector-token") =>
    fetch(base + "/connector/v1/" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    store,
    post,
    github,
    coordinator,
    setAuthorized: (x: boolean) => {
      authorized = x;
    },
    counts: () => ({ authorizations, reads, publications }),
  };
}
test("connector auth precedes claim and caller auth precedes prompt disclosure", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  let r = await f.post("claim", {}, "admin-token");
  assert.equal(r.status, 401);
  assert.equal(f.store.get(task.id)?.status, "queued");
  assert.equal(f.counts().authorizations, 0);
  f.setAuthorized(false);
  r = await f.post("claim", {});
  assert.equal(r.status, 204);
  assert.doesNotMatch(await r.text(), /secret issue prompt/);
  assert.equal(f.store.get(task.id)?.status, "rejected");
  f.setAuthorized(true);
  const next = f.store.accept({
    ...input,
    deliveryId: "d2",
    commentId: 2,
  }).task;
  const response = await f.post("claim", {});
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { task: { id: string } }).task.id,
    next.id,
  );
});
test("claim one assignment, authorize scoped tools, persist idempotent result and publish once", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const r = await f.post("claim", {});
  assert.equal(r.status, 200);
  const lease = (await r.json()) as any;
  assert.equal(lease.task.id, task.id);
  assert.ok(lease.leaseToken.length >= 32);
  assert.equal((await f.post("claim", {})).status, 204);
  let tool = await f.post(`tasks/${task.id}/tool`, {
    leaseToken: lease.leaseToken,
    name: "read_issue",
    args: { owner: "evil" },
  });
  assert.equal(tool.status, 400);
  assert.equal(f.counts().reads, 0);
  tool = await f.post(`tasks/${task.id}/tool`, {
    leaseToken: lease.leaseToken,
    name: "read_issue",
    args: {},
  });
  assert.equal(tool.status, 200);
  assert.equal(((await tool.json()) as any).title, "org/repo");
  f.setAuthorized(false);
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: lease.leaseToken,
        name: "read_issue",
        args: {},
      })
    ).status,
    403,
  );
  f.setAuthorized(true);
  const body = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    text: "answer",
  };
  assert.equal((await f.post(`tasks/${task.id}/result`, body)).status, 200);
  assert.equal((await f.post(`tasks/${task.id}/result`, body)).status, 200);
  assert.equal(
    (await f.post(`tasks/${task.id}/result`, { ...body, text: "other" }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: lease.leaseToken,
        name: "read_issue",
        args: {},
      })
    ).status,
    409,
  );
  const worker = new DeliveryWorker(f.store, f.github);
  await worker.tick();
  await worker.tick();
  assert.equal(f.counts().publications, 1);
  assert.equal(f.store.get(task.id)?.deliveryStatus, "sent");
});
test("expiry fences tools and late result without automatic reissue", async (t) => {
  const f = await fixture(t, 100);
  const task = f.store.accept(input).task;
  const lease = (await (await f.post("claim", {})).json()) as any;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: lease.leaseToken,
        name: "read_issue",
        args: {},
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: lease.leaseToken,
        status: "succeeded",
        text: "late",
      })
    ).status,
    409,
  );
  assert.equal(f.store.get(task.id)?.status, "unknown");
  assert.equal((await f.post("claim", {})).status, 204);
});
test("strict and bounded bodies never invoke tools or accept a malformed result", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post("claim", { workerId: "override" })).status, 400);
  assert.equal((await f.post("claim", { x: "a".repeat(5000) })).status, 413);
  const task = f.store.accept(input).task;
  const lease = (await (await f.post("claim", {})).json()) as any;
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: lease.leaseToken,
        status: "succeeded",
        text: "x".repeat(18001),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: lease.leaseToken,
        status: "failed",
        text: "ignored",
      })
    ).status,
    400,
  );
  assert.equal(f.store.get(task.id)?.status, "running");
});
test("delivery-only worker never claims queued task", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const worker = new DeliveryWorker(f.store, f.github);
  assert.equal(await worker.tick(), false);
  assert.equal(f.store.get(task.id)?.status, "queued");
});

test("returned result cannot publish after actor loses permission", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const lease = (await (await f.post("claim", {})).json()) as {
    leaseToken: string;
  };
  const body = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    text: "result before revoke",
  };
  assert.equal((await f.post(`tasks/${task.id}/result`, body)).status, 200);
  f.setAuthorized(false);
  await new DeliveryWorker(f.store, f.github).tick();
  assert.equal(f.counts().publications, 0);
  assert.equal(f.store.get(task.id)?.deliveryStatus, "failed");
});

test("lease token scopes every tool and result; canonical retry ignores JSON key order", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const lease = (await (await f.post("claim", {})).json()) as {
    leaseToken: string;
  };
  const wrong = "a".repeat(64);
  assert.equal(
    (
      await f.post(`tasks/${task.id}/tool`, {
        leaseToken: wrong,
        name: "read_issue",
        args: {},
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(`tasks/${task.id}/result`, {
        leaseToken: wrong,
        status: "succeeded",
        text: "wrong",
      })
    ).status,
    409,
  );
  assert.equal(f.counts().reads, 0);
  const first = await f.post(`tasks/${task.id}/result`, {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    text: "correct",
    responseId: "r",
  });
  assert.deepEqual(await first.json(), { accepted: true, duplicate: false });
  const second = await f.post(`tasks/${task.id}/result`, {
    responseId: "r",
    text: "correct",
    status: "succeeded",
    leaseToken: lease.leaseToken,
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, duplicate: true });
});

test("storage failure returns retryable 503 and same result is persisted once on retry", async (t) => {
  const f = await fixture(t);
  const task = f.store.accept(input).task;
  const lease = (await (await f.post("claim", {})).json()) as {
    leaseToken: string;
  };
  const finish = f.store.finishAssignment.bind(f.store);
  let failed = false;
  t.mock.method(
    f.store,
    "finishAssignment",
    (...args: Parameters<TaskStore["finishAssignment"]>) => {
      if (!failed) {
        failed = true;
        throw new Error("SQLITE_BUSY fixture private detail");
      }
      return finish(...args);
    },
  );
  const payload = {
    leaseToken: lease.leaseToken,
    status: "succeeded",
    text: "retained result",
  };
  const first = await f.post(`tasks/${task.id}/result`, payload);
  assert.equal(first.status, 503);
  assert.doesNotMatch(await first.text(), /SQLITE_BUSY|private detail/);
  assert.equal(f.store.get(task.id)?.status, "running");
  const second = await f.post(`tasks/${task.id}/result`, payload);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, duplicate: false });
  const third = await f.post(`tasks/${task.id}/result`, payload);
  assert.deepEqual(await third.json(), { accepted: true, duplicate: true });
  await new DeliveryWorker(f.store, f.github).tick();
  assert.equal(f.counts().publications, 1);
});
