import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/store.js";
import type { NewTask } from "../src/contracts.js";
import { fixtureAgent, seedBinding } from "./binding-fixture.js";

test("observation survives duplicate delivery, alternate comment identity and policy changes without executing", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const binding = seedBinding(store, scope, "device");
  const input: NewTask = {
    ...scope,
    bindingId: binding.id,
    deliveryId: "original",
    actorId: 4,
    actorLogin: "alice",
    prompt: "ordinary comment",
    target: { kind: "issue", number: 2 },
    source: { event: "issue_comment", action: "created", commentId: 1 },
  };
  store.observe({ input, reason: "observed", execute: false });
  const duplicate = store.observe({
    input: { ...input, deliveryId: "alternate" },
    reason: "mention",
    execute: true,
  });
  assert.equal(duplicate.taskId, null);
  assert.equal(duplicate.duplicate, true);
  store.observe({ input, reason: "observed", execute: false });
  assert.equal(store.activityReceipt("original")?.attempts, 2);
  assert.equal(store.activityReceipt("alternate")?.duplicate, true);
  assert.equal(store.activityReceipt("alternate")?.reason, "observed");
  assert.equal(store.recentThread({ ...input, deliveryId: "" }).length, 1);
  assert.equal(
    store.activitiesForDevice("other", 0, 10, fixtureAgent, binding.id)
      .activities.length,
    0,
  );
  assert.equal(
    store.activitiesForDevice("device", 0, 10, fixtureAgent, binding.id)
      .activities[0]?.excerpt,
    "ordinary comment",
  );
  assert.equal(
    store.claimAssignment("device", "lease", Date.now() + 1_000),
    undefined,
  );
  store.registry.apply(
    { ...scope, deviceId: "device", administratorId: 44 },
    1,
    { enabled: false },
  );
  assert.deepEqual(store.recentThread(input), []);
  assert.deepEqual(
    store.activitiesForDevice("device", 0, 10, fixtureAgent, binding.id)
      .activities,
    [],
  );
});

test("failure between task creation and receipt rolls back both; restart keeps the accepted decision", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-activity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cloud.db");
  const store = new TaskStore(path);
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const binding = seedBinding(store, scope, "device");
  const input: NewTask = {
    ...scope,
    bindingId: binding.id,
    deliveryId: "first",
    target: { kind: "issue", number: 1 },
    source: { event: "issue_comment", action: "created", commentId: 1 },
    actorId: 3,
    actorLogin: "user",
    prompt: "@channel answer",
  };
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;",
    );
    assert.throws(
      () => store.observe({ input, execute: true, reason: "mention" }),
      /receipt unavailable/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM activities").get()?.n,
      0,
    );
    db.exec("DROP TRIGGER reject_receipt");
    assert.ok(
      store.observe({ input, execute: true, reason: "mention" }).taskId,
    );
  } finally {
    db.close();
    store.close();
  }
  const restored = new TaskStore(path);
  try {
    const saved = restored.activityReceipt("first");
    assert.ok(saved?.taskId);
    assert.equal(saved.activity?.excerpt, input.prompt);
    assert.equal(
      restored.observe({ input, execute: true, reason: "mention" }).duplicate,
      true,
    );
    assert.equal(restored.get(saved.taskId)?.status, "queued");
  } finally {
    restored.close();
  }
});

test("repeated automatic reviews link the same task, and close fences only that thread", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const binding = seedBinding(store, scope, "device", [
    "pull_request.synchronize",
    "pull_request.closed",
    "push",
  ]);
  const input: NewTask = {
    ...scope,
    bindingId: binding.id,
    deliveryId: "first",
    actorId: 4,
    actorLogin: "alice",
    prompt: "review",
    source: { event: "pull_request", action: "synchronize" },
    target: {
      kind: "pull_request",
      number: 5,
      revision: {
        baseRepoId: 2,
        headRepoId: 2,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    },
  };
  const first = store.observe({ input, reason: "review", execute: true });
  const duplicate = store.observe({
    input: { ...input, deliveryId: "second" },
    reason: "review",
    execute: true,
  });
  assert.ok(first.taskId);
  assert.equal(duplicate.taskId, first.taskId);
  assert.equal(duplicate.duplicate, true);
  const push = store.observe({
    input: {
      ...input,
      deliveryId: "push",
      target: { kind: "repository", sha: "b".repeat(40) },
      source: { event: "push" },
    },
    execute: false,
    reason: "observed",
  });
  assert.equal(push.taskId, null);
  const now = Date.now();
  assert.equal(
    store.claimAssignment("device", "wrong", now + 10000, now, {
      ...fixtureAgent,
      id: "other",
    }),
    undefined,
  );
  assert.equal(
    store.claimAssignment("device", "lease", now + 10000, now, fixtureAgent)
      ?.id,
    first.taskId,
  );
  const changed = store.observe({
    input: {
      ...input,
      deliveryId: "other-head",
      target: {
        kind: "pull_request",
        number: 5,
        revision: {
          baseRepoId: 2,
          headRepoId: 2,
          baseSha: "a".repeat(40),
          headSha: "c".repeat(40),
        },
      },
    },
    execute: true,
    reason: "review",
  });
  const unrelated = store.observe({
    input: {
      ...input,
      deliveryId: "other-pr",
      target: { ...input.target, kind: "pull_request", number: 6 },
    },
    execute: true,
    reason: "review",
  });
  store.observe({
    input: {
      ...input,
      deliveryId: "closed",
      source: { event: "pull_request", action: "closed" },
    },
    execute: false,
    reason: "closed",
  });
  assert.equal(store.get(first.taskId)?.status, "unknown");
  assert.equal(store.get(changed.taskId!)?.status, "rejected");
  assert.equal(store.publicationAllowed(first.taskId), false);
  assert.equal(store.get(unrelated.taskId!)?.status, "queued");
  assert.throws(() =>
    store.finishAssignment(
      first.taskId!,
      "device",
      "lease",
      { status: "failed" },
      "digest",
      now,
    ),
  );
  const page = store.activitiesForDevice(
    "device",
    0,
    2,
    fixtureAgent,
    binding.id,
  );
  assert.equal(page.activities.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(
    store.activitiesForDevice(
      "device",
      page.nextCursor,
      2,
      fixtureAgent,
      binding.id,
    ).activities[0].deliveryId,
    "push",
  );
  assert.deepEqual(
    store.activitiesForDevice(
      "device",
      0,
      2,
      { ...fixtureAgent, id: "other" },
      binding.id,
    ).activities,
    [],
  );
});

test("expired activity leaves a durable decision, reports a cursor gap and cannot be promoted", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const binding = seedBinding(store, scope, "device");
  const input: NewTask = {
    ...scope,
    bindingId: binding.id,
    deliveryId: "old",
    actorId: 4,
    actorLogin: "alice",
    prompt: "x".repeat(2000),
    source: { event: "issue_comment", action: "created", commentId: 1 },
    target: { kind: "issue", number: 1 },
  };
  const clock = t.mock.method(Date, "now", () => 1_000_000);
  const first = store.observe({ input, execute: false, reason: "observed" });
  assert.equal(store.activityReceipt("old")?.activity?.truncated, true);
  assert.equal(store.activityReceipt("old")?.activity?.excerpt.length, 1024);
  clock.mock.mockImplementation(() => 1_000_000 + 7 * 24 * 3600 * 1000);
  assert.equal(store.activityReceipt("old")?.activity, null);
  const expired = store.activitiesForDevice(
    "device",
    0,
    10,
    fixtureAgent,
    binding.id,
  );
  assert.deepEqual(expired, {
    activities: [],
    nextCursor: first.cursor,
    hasMore: false,
    truncated: true,
  });
  assert.equal(
    store.observe({ input, execute: true, reason: "mention" }).taskId,
    null,
  );
  assert.equal(
    store.activitiesForDevice(
      "device",
      expired.nextCursor,
      10,
      fixtureAgent,
      binding.id,
    ).truncated,
    false,
  );
});

test("out-of-order closures fence only actions not provably newer, across restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "tasks.db");
  let store = new TaskStore(db);
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const binding = seedBinding(store, scope, "device", [
    "issues.closed",
    "issue_comment.created",
  ]);
  const base = {
    ...scope,
    bindingId: binding.id,
    actorId: 1,
    actorLogin: "alice",
    prompt: "event",
    target: { kind: "issue" as const, number: 2 },
  };
  let count = 0;
  const act = (githubTime?: number) =>
    store.observe({
      execute: true,
      reason: "mention",
      githubTime,
      input: {
        ...base,
        deliveryId: "comment-" + ++count,
        source: { event: "issue_comment", action: "created", commentId: count },
      },
    });
  const close = (githubTime?: number) =>
    store.observe({
      execute: false,
      reason: "closed",
      githubTime,
      input: {
        ...base,
        deliveryId: "close-" + ++count,
        source: { event: "issues", action: "closed" },
      },
    });
  try {
    const old = act(10),
      fresh = act(30);
    close(20);
    assert.equal(store.get(old.taskId!)?.status, "rejected");
    assert.equal(store.publicationAllowed(old.taskId!), false);
    assert.equal(store.get(fresh.taskId!)?.status, "queued");
    assert.equal(store.publicationAllowed(fresh.taskId!), true);
    store.close();
    store = new TaskStore(db);
    close(15);
    for (const when of [undefined, 18, 20]) {
      const late = act(when);
      assert.equal(late.reason, "closed");
      assert.equal(late.taskId, null);
    }
    const next = act(40);
    assert.ok(next.taskId);
    for (let i = 0; i < 10; i++) act(50 + i);
    assert.deepEqual(store.recentThread(store.get(old.taskId!)!), []);
    assert.equal(store.recentThread(store.get(fresh.taskId!)!).length, 1);
    close();
    assert.equal(act(99).taskId, null);
  } finally {
    store.close();
  }
});

test("automatic review dedup does not reuse a task fenced by a prior close", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = {
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  const binding = seedBinding(store, scope, "device", [
    "pull_request.synchronize",
    "pull_request.closed",
  ]);
  const input: NewTask = {
    ...scope,
    bindingId: binding.id,
    actorId: 4,
    actorLogin: "alice",
    prompt: "review",
    deliveryId: "first",
    source: { event: "pull_request", action: "synchronize" },
    target: {
      kind: "pull_request",
      number: 2,
      revision: {
        baseRepoId: 2,
        headRepoId: 2,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    },
  };
  const review = (deliveryId: string, githubTime: number) =>
    store.observe({
      input: { ...input, deliveryId },
      execute: true,
      reason: "review",
      githubTime,
    });
  const first = review("first", 10);
  store.observe({
    input: {
      ...input,
      deliveryId: "closed",
      source: { event: "pull_request", action: "closed" },
    },
    reason: "closed",
    execute: false,
    githubTime: 20,
  });
  const next = review("new", 30);
  assert.ok(next.taskId);
  assert.notEqual(next.taskId, first.taskId);
  assert.equal(review("repeat", 35).taskId, next.taskId);
});

test("a late close separates coalesced reviews without replaying dispatched work", (t) => {
  const clock = t.mock.method(Date, "now", () => 1_000);
  for (const phase of ["queued", "dispatched", "published"]) {
    clock.mock.mockImplementation(() => 1_000);
    const store = new TaskStore(":memory:");
    t.after(() => store.close());
    const scope = {
      installationId: 1,
      repositoryId: 2,
      owner: "org",
      repo: "repo",
    };
    const binding = seedBinding(store, scope, "device", [
      "pull_request.synchronize",
      "pull_request.closed",
    ]);
    const base: NewTask = {
      ...scope,
      bindingId: binding.id,
      actorId: 4,
      actorLogin: "alice",
      prompt: "first review",
      deliveryId: "old",
      source: { event: "pull_request", action: "synchronize" },
      target: {
        kind: "pull_request",
        number: 2,
        revision: {
          baseRepoId: 2,
          headRepoId: 2,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
        },
      },
    };
    const old = store.observe({
      input: base,
      execute: true,
      reason: "review",
      githubTime: 10,
    });
    const fresh = {
      ...base,
      deliveryId: "fresh",
      actorId: 5,
      actorLogin: "bob",
      prompt: "reopened review",
    };
    const repeat = store.observe({
      input: fresh,
      execute: true,
      reason: "review",
      githubTime: 30,
    });
    assert.equal(repeat.taskId, old.taskId);
    clock.mock.mockImplementation(() => 9_000);
    if (phase !== "queued")
      store.claimAssignment("device", "lease", Date.now() + 60000);
    if (phase === "published") {
      store.finishAssignment(
        old.taskId!,
        "device",
        "lease",
        {
          status: "succeeded",
          outcome: {
            text: "Reviewed",
            artifacts: [],
            publication: { kind: "comment" },
          },
        },
        "digest",
      );
      assert.equal(store.pendingDelivery()?.id, old.taskId);
      store.markDelivery(old.taskId!, "sent", {
        kind: "comment",
        id: 1,
        url: "https://github.com/org/repo/pull/2#issuecomment-1",
      });
    }
    store.observe({
      input: {
        ...base,
        deliveryId: "close",
        source: { event: "pull_request", action: "closed" },
      },
      execute: false,
      reason: "closed",
      githubTime: 20,
    });
    const receipt = store.activityReceipt("fresh")!;
    if (phase !== "queued") {
      assert.equal(receipt.taskId, old.taskId);
      if (phase === "published") {
        assert.equal(store.get(old.taskId!)?.deliveryStatus, "sent");
        assert.equal(receipt.reviewFollowUp, undefined);
      } else
        assert.equal(receipt.reviewFollowUp, "reconcile_before_new_review");
      assert.equal(
        store.claimAssignment("device", "next", Date.now() + 60000),
        undefined,
      );
    } else {
      assert.notEqual(receipt.taskId, old.taskId);
      assert.equal(receipt.activity?.taskId, receipt.taskId);
      assert.equal(store.get(old.taskId!)?.status, "rejected");
      const next = store.claimAssignment("device", "next", Date.now() + 60000);
      assert.equal(next?.id, receipt.taskId);
      assert.equal(next?.createdAt, 1_000);
      assert.equal(next?.actorId, 5);
      assert.equal(next?.prompt, "reopened review");
    }
  }
});

test("same-version fresh delivery after reassignment cannot reuse a never-dispatched retired task", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = { installationId: 1, repositoryId: 2, owner: "o", repo: "r" };
  const b = seedBinding(store, scope, "device", ["pull_request.synchronize"]);
  const input: NewTask = {
    ...scope,
    bindingId: b.id,
    deliveryId: "first",
    actorId: 4,
    actorLogin: "alice",
    prompt: "r",
    source: { event: "pull_request", action: "synchronize" },
    target: {
      kind: "pull_request",
      number: 2,
      revision: {
        baseRepoId: 2,
        headRepoId: 2,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    },
  };
  const first = store.observe({
    input,
    reason: "review",
    execute: true,
    githubTime: 10,
  });
  store.registry.apply(
    { ...scope, deviceId: "device", administratorId: 44 },
    1,
    {
      enabled: true,
      responsibleAgent: { ...fixtureAgent, id: "new" },
      events: ["pull_request.synchronize"],
    },
  );
  const now = store.activeBinding(1, 2)!;
  const accept = (deliveryId: string) =>
    store.observe({
      input: { ...input, bindingId: now.id, deliveryId },
      reason: "review",
      execute: true,
      githubTime: 20,
    });
  assert.equal(accept("first").taskId, first.taskId);
  const next = accept("new");
  assert.notEqual(next.taskId, first.taskId);
  assert.equal(store.get(next.taskId!)?.bindingId, now.id);
});

test("late close detaches stale receipts from a newer running review without replay", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = { installationId: 1, repositoryId: 2, owner: "org", repo: "r" };
  const binding = seedBinding(store, scope, "device", [
    "pull_request.synchronize",
    "pull_request.closed",
  ]);
  const target = {
    kind: "pull_request" as const,
    number: 2,
    revision: {
      baseRepoId: 2,
      headRepoId: 2,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
  };
  const review = (deliveryId: string, githubTime?: number) =>
    store.observe({
      input: {
        ...scope,
        bindingId: binding.id,
        deliveryId,
        actorId: 42,
        actorLogin: "alice",
        prompt: "review",
        target,
        source: { event: "pull_request", action: "synchronize" },
      },
      execute: true,
      reason: "review",
      githubTime,
    });
  const fresh = review("post", 30);
  for (const [id, when] of [
    ["pre", 10],
    ["tie", 20],
    ["unknown", undefined],
    ["other-post", 35],
  ] as const) {
    assert.equal(review(id, when).taskId, fresh.taskId);
  }
  assert.equal(
    store.claimAssignment("device", "lease", Date.now() + 60000)?.id,
    fresh.taskId,
  );
  store.closeThread({
    ...scope,
    bindingId: binding.id,
    target,
    githubTime: 20,
  });
  const feed = store.activitiesForDevice(
    "device",
    0,
    100,
    fixtureAgent,
    binding.id,
  ).activities;
  for (const id of ["pre", "tie", "unknown"]) {
    const receipt = store.activityReceipt(id)!;
    assert.equal(receipt.taskId, null);
    assert.equal(receipt.reason, "closed");
    assert.equal(receipt.activity?.taskId, null);
    assert.equal(feed.find((a) => a.deliveryId === id)?.reason, "closed");
    assert.equal(feed.find((a) => a.deliveryId === id)?.taskId, null);
    assert.equal(review(id, 50).taskId, null);
  }
  assert.equal(store.activityReceipt("other-post")?.taskId, fresh.taskId);
  assert.equal(store.activityReceipt("post")?.taskId, fresh.taskId);
  assert.equal(
    store.assignedTask(fresh.taskId!, "device", "lease")?.status,
    "running",
  );
  assert.equal(store.publicationAllowed(fresh.taskId!), true);
});

test("a delayed intermediate closure detaches a later alias even when both lifetimes have since closed", (t) => {
  const store = new TaskStore(":memory:");
  t.after(() => store.close());
  const scope = { installationId: 1, repositoryId: 2, owner: "org", repo: "r" };
  const binding = seedBinding(store, scope, "device", [
    "pull_request.synchronize",
    "pull_request.closed",
  ]);
  const target = {
    kind: "pull_request" as const,
    number: 2,
    revision: {
      baseRepoId: 2,
      headRepoId: 2,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
  };
  const review = (deliveryId: string, githubTime?: number) =>
    store.observe({
      input: {
        ...scope,
        bindingId: binding.id,
        deliveryId,
        actorId: 42,
        actorLogin: "alice",
        prompt: "review",
        target,
        source: { event: "pull_request", action: "synchronize" },
      },
      execute: true,
      reason: "review",
      githubTime,
    });
  const first = review("old", 10);
  assert.equal(review("after", 30).taskId, first.taskId);
  for (const githubTime of [40, 20])
    store.closeThread({ ...scope, bindingId: binding.id, target, githubTime });
  assert.equal(store.get(first.taskId!)?.status, "rejected");
  assert.equal(store.activityReceipt("after")?.taskId, null);
  assert.equal(store.activityReceipt("after")?.activity?.reason, "closed");
  assert.equal(review("after", 30).taskId, null);
  assert.equal(
    store.claimAssignment("device", "lease", Date.now() + 60000),
    undefined,
  );
});
