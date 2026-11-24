import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/store.js";
import { DeliveryWorker } from "../src/worker.js";
import {
  AccessDenied,
  AmbiguousExecution,
  type NewTask,
  type GitHubClient,
} from "../src/contracts.js";
const input: NewTask = {
  deliveryId: "d1",
  source: { event: "issue_comment", action: "created", commentId: 1 },
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "alice",
  target: { kind: "issue", number: 4 },
  prompt: "review",
};
function github(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    authorize: async () => {},
    readIssue: async () => ({}),
    readFile: async () => ({}),
    publishPullRequest: async () => {
      throw new Error("Unexpected PR publication");
    },
    publishComment: async () => ({
      id: 10,
      url: "https://github.com/org/repo/issues/4#issuecomment-10",
    }),
    ...overrides,
  };
}
function ready(t: test.TestContext) {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const task = store.accept(input).task;
  store.claimAssignment("worker", "hash", Date.now() + 60000);
  store.finishAssignment(
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
  return { store, task };
}
test("delivery worker publishes persisted connector result once", async (t) => {
  const { store, task } = ready(t);
  let attempts = 0;
  const worker = new DeliveryWorker(
    store,
    github({
      publishComment: async (received, text) => {
        assert.equal(received.id, task.id);
        assert.equal(text, "answer");
        attempts++;
        return {
          id: 10,
          url: "https://github.com/org/repo/issues/4#issuecomment-10",
        };
      },
    }),
  );
  assert.equal(await worker.tick(), true);
  assert.equal(await worker.tick(), false);
  assert.equal(attempts, 1);
  assert.equal(store.get(task.id)?.deliveryStatus, "sent");
  assert.deepEqual(store.get(task.id)?.publicationReceipt, {
    kind: "comment",
    id: 10,
    url: "https://github.com/org/repo/issues/4#issuecomment-10",
  });
});
test("lost publication result becomes unknown and is never retried automatically", async (t) => {
  const { store, task } = ready(t);
  let attempts = 0;
  const worker = new DeliveryWorker(
    store,
    github({
      publishComment: async () => {
        attempts++;
        throw new AmbiguousExecution();
      },
    }),
  );
  await worker.tick();
  await worker.tick();
  assert.equal(attempts, 1);
  assert.equal(store.get(task.id)?.deliveryStatus, "unknown");
});
test("permission revoked before publication blocks writes", async (t) => {
  const { store, task } = ready(t);
  let attempts = 0;
  const worker = new DeliveryWorker(
    store,
    github({
      authorize: async () => {
        throw new AccessDenied();
      },
      publishComment: async () => {
        attempts++;
        throw new Error("unexpected");
      },
    }),
  );
  await worker.tick();
  assert.equal(attempts, 0);
  assert.equal(store.get(task.id)?.deliveryStatus, "failed");
});
test("delivery worker leaves queued execution untouched", async (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const task = store.accept(input).task;
  const worker = new DeliveryWorker(store, github());
  assert.equal(await worker.tick(), false);
  assert.equal(store.get(task.id)?.status, "queued");
});
test("overlapping ticks do not publish twice", async (t) => {
  const { store } = ready(t);
  let unblock!: () => void;
  const gate = new Promise<void>((r) => (unblock = r));
  let attempts = 0;
  const worker = new DeliveryWorker(
    store,
    github({
      publishComment: async () => {
        attempts++;
        await gate;
        return { id: 1, url: "url" };
      },
    }),
  );
  const first = worker.tick();
  assert.equal(await worker.tick(), false);
  unblock();
  await first;
  assert.equal(attempts, 1);
});

test("unavailable preflight does not freeze the next queued task", async (t) => {
  const { store, task } = ready(t);
  const next = store.accept({
    ...input,
    deliveryId: "next",
    source: { ...input.source, commentId: 2 },
  }).task;
  let writes = 0;
  const w = new DeliveryWorker(
    store,
    github({
      authorize: async () => {
        throw Error("PR unavailable");
      },
      publishComment: async () => {
        writes++;
        throw Error("unexpected");
      },
    }),
  );
  await w.tick();
  assert.equal(writes, 0);
  assert.equal(store.get(task.id)?.deliveryStatus, "failed");
  assert.equal(
    store.claimAssignment("worker", "next", Date.now() + 60000)?.id,
    next.id,
  );
});
