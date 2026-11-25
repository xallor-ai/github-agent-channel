import { seedBinding } from "./binding-fixture.js";
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
  bindingId: "1:2:worker:1",
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
function ready(t: test.TestContext, native = false) {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  seedBinding(store, input, "worker");
  const task = store.accept(
    native
      ? {
          ...input,
          target: {
            kind: "pull_request",
            number: 4,
            revision: {
              baseRepoId: 2,
              headRepoId: 2,
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
            },
          },
        }
      : input,
  ).task;
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
        publication: { kind: native ? "review" : "comment" },
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
  seedBinding(store, input, "worker");
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

test("disabling a binding during authorization prevents the reserved publication from being sent", async (t) => {
  const { store, task } = ready(t);
  let attempts = 0;
  await new DeliveryWorker(
    store,
    github({
      authorize: async () => {
        store.registry.revokeDevice("worker");
      },
      publishComment: async () => {
        attempts++;
        return { id: 1, url: "unexpected" };
      },
    }),
  ).tick();
  assert.equal(attempts, 0);
  assert.equal(store.get(task.id)?.deliveryStatus, "failed");
});

test("native review is never downgraded or replayed", async (t) => {
  for (const mode of ["missing", "lost", "ok"] as const) {
    const { store, task } = ready(t, true);
    let reviews = 0;
    let comments = 0;
    const url = "https://github.com/org/repo/pull/4#pullrequestreview-12";
    const worker = new DeliveryWorker(
      store,
      github({
        publishComment: async () => {
          comments++;
          throw Error("unexpected");
        },
        ...(mode === "missing"
          ? {}
          : {
              publishReview: async () => {
                reviews++;
                if (mode === "lost") throw new AmbiguousExecution();
                return { id: 12, url };
              },
            }),
      }),
    );
    await worker.tick();
    await worker.tick();
    assert.equal(comments, 0);
    assert.equal(reviews, mode === "missing" ? 0 : 1);
    const current = store.get(task.id);
    assert.equal(
      current?.deliveryStatus,
      mode === "ok" ? "sent" : mode === "lost" ? "unknown" : "failed",
    );
    if (mode === "ok")
      assert.deepEqual(current?.publicationReceipt, {
        kind: "review",
        id: 12,
        url,
      });
  }
});

test("a confirmed analysis failure sends one status notice without inventing an outcome; unknown execution is silent", async (t) => {
  for (const status of ["failed", "unknown"] as const) {
    const store = new TaskStore(":memory:");
    t.after(() => store.close());
    seedBinding(store, input, "worker");
    const task = store.accept(input).task;
    store.claimAssignment("worker", "hash", Date.now() + 60000);
    store.finishAssignment(
      task.id,
      "worker",
      "hash",
      {
        status,
        failure: status === "failed" ? "no_final_answer" : "runtime_transport",
      },
      "digest",
    );
    if (status === "unknown") store.resolveUnknown(task.id, "failed");
    const notices: string[] = [];
    const worker = new DeliveryWorker(
      store,
      github({
        publishComment: async (_, body) => {
          notices.push(body);
          return {
            id: 10,
            url: "https://github.com/org/repo/issues/4#issuecomment-10",
          };
        },
      }),
    );
    await worker.tick();
    await worker.tick();
    assert.equal(notices.length, status === "failed" ? 1 : 0);
    if (status === "failed") {
      assert.match(notices[0]!, /no_final_answer/);
      assert.equal(store.get(task.id)?.deliveryStatus, "sent");
    }
    assert.equal(store.get(task.id)?.status, "failed");
    assert.equal(store.get(task.id)?.outcome, null);
  }
});
