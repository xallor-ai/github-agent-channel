import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/store.js";
import {
  ReceiptScopeDenied,
  ExpiredActivities,
} from "../src/owner-receipts.js";
import { fixtureAgent, seedBinding } from "./binding-fixture.js";
import type { NewTask } from "../src/contracts.js";
const scope = { installationId: 1, repositoryId: 2, owner: "org", repo: "app" };
function open(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "owner-receipt-"));
  const path = join(dir, "channel.sqlite");
  let store = new TaskStore(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const b = seedBinding(store, scope, "phone");
  function observe(id: number, mention = true) {
    const deliveryId = "d" + id;
    const input: NewTask = {
      ...scope,
      bindingId: b.id,
      actorId: 1,
      actorLogin: "owner",
      deliveryId,
      target: { kind: "issue", number: 11 },
      source: { event: "issue_comment", action: "created", commentId: id },
      prompt: mention ? "@app hi" : "discussion",
    };
    const d = store.observe(
      mention
        ? { input, execute: true, reason: "mention", githubTime: 10 }
        : { input, execute: false, reason: "observed", githubTime: 10 },
    );
    return { input, taskId: d.taskId, entry: { deliveryId, cursor: d.cursor } };
  }
  return {
    get store() {
      return store;
    },
    observe,
    b,
    path,
    restart() {
      store.close();
      store = new TaskStore(path);
      store.recover();
    },
  };
}
test("receipt follows the exact bound activity, not a delivery alias, cursor alone or another runtime", (t) => {
  const f = open(t),
    a = f.observe(1, false),
    m = f.observe(2);
  const other = seedBinding(
    f.store,
    { ...scope, repositoryId: 3, repo: "other" },
    "phone",
  );
  for (const [device, profile, binding] of [
    ["laptop", fixtureAgent, f.b.id],
    ["phone", { ...fixtureAgent, id: "other" }, f.b.id],
    ["phone", fixtureAgent, other.id],
  ] as const) {
    assert.throws(
      () => f.store.confirmActivities(device, profile, binding, [m.entry]),
      ReceiptScopeDenied,
    );
  }
  f.store.observe({
    input: { ...m.input, deliveryId: "alias" },
    execute: true,
    reason: "mention",
  });
  const confirm = (entries: (typeof m.entry)[]) =>
    f.store.confirmActivities("phone", fixtureAgent, f.b.id, entries);
  assert.throws(
    () => confirm([a.entry, { ...m.entry, deliveryId: "alias" }]),
    ReceiptScopeDenied,
  );
  assert.equal(f.store.ownerReceipt(a.entry.deliveryId), null);
  assert.equal(f.store.reserveReaction(), undefined);
  confirm([a.entry, m.entry]);
  assert.equal(
    f.store.ownerReceipt(a.entry.deliveryId)?.decision,
    "silent_by_policy",
  );
  assert.equal(f.store.ownerReceipt(a.entry.deliveryId)?.reaction, null);
  const first = f.store.ownerReceipt("d2");
  assert.equal(first?.decision, null);
  assert.equal(first?.reaction?.status, "pending");
  assert.deepEqual(f.store.ownerReceipt("alias"), first);
  assert.equal(f.store.reserveReaction()?.id, m.taskId);
  f.restart();
  assert.equal(f.store.ownerReceipt("d2")?.reaction?.status, "unknown");
  assert.equal(f.store.reserveReaction(), undefined);
  confirm([m.entry]);
  assert.equal(f.store.reactionUnknown(m.taskId!), true);
  assert.throws(() => f.store.reconcileReaction(m.taskId!, 0));
  f.store.reconcileReaction(m.taskId!, 123);
  assert.deepEqual(f.store.ownerReceipt("alias")?.reaction, {
    status: "sent",
    reason: null,
    reactionId: 123,
  });
  assert.equal(f.store.get(m.taskId!)?.status, "queued");
});
test("expired originals are distinguished from wrong scope; a mixed batch rolls back, previously accepted receipts survive pruning", (t) => {
  const f = open(t),
    a = f.observe(1),
    b = f.observe(2),
    c = f.observe(3);
  const ack = (entries: (typeof a.entry)[]) =>
    f.store.confirmActivities("phone", fixtureAgent, f.b.id, entries);
  ack([a.entry]);
  const disk = new DatabaseSync(f.path);
  try {
    disk
      .prepare("DELETE FROM activities WHERE cursor IN (?,?)")
      .run(a.entry.cursor, b.entry.cursor);
  } finally {
    disk.close();
  }
  ack([a.entry]);
  assert.throws(
    () => ack([c.entry, b.entry]),
    (e) =>
      e instanceof ExpiredActivities &&
      e.expired.length === 1 &&
      e.expired[0].deliveryId === b.entry.deliveryId,
  );
  assert.equal(f.store.ownerReceipt("d3"), null);
  assert.throws(
    () => ack([b.entry, { ...b.entry, cursor: c.entry.cursor }]),
    ReceiptScopeDenied,
  );
  ack([c.entry]);
  assert.equal(f.store.ownerReceipt("d3")?.reaction?.status, "pending");
});
test("rebinding or close fences pending eyes even if the primary task was already delivered", (t) => {
  const f = open(t),
    m = f.observe(1);
  f.store.confirmActivities("phone", fixtureAgent, f.b.id, [m.entry]);
  const disk = new DatabaseSync(f.path);
  try {
    disk
      .prepare(
        "UPDATE tasks SET status='succeeded',deliveryStatus='sent' WHERE id=?",
      )
      .run(m.taskId!);
  } finally {
    disk.close();
  }
  f.store.closeThread({
    ...scope,
    bindingId: f.b.id,
    target: { kind: "issue", number: 11 },
    githubTime: 12,
  });
  assert.equal(f.store.reactionAllowed(m.taskId!), false);
  assert.equal(f.store.reserveReaction(), undefined);
  assert.equal(f.store.ownerReceipt("d1")?.reaction?.reason, "scope");
  f.store.registry.revokeDevice("phone");
  assert.throws(
    () => f.store.confirmActivities("phone", fixtureAgent, f.b.id, [m.entry]),
    ReceiptScopeDenied,
  );
});
test("two offline days expire execution, not the receipt of the original comment", (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = open(t),
    item = f.observe(1);
  now += 2 * 24 * 3600_000;
  f.store.expireTasks();
  assert.equal(f.store.get(item.taskId!)?.status, "rejected");
  f.store.confirmActivities("phone", fixtureAgent, f.b.id, [item.entry]);
  assert.equal(f.store.reserveReaction()?.id, item.taskId);
  f.store.registry.revokeDevice("phone");
  assert.equal(f.store.reactionAllowed(item.taskId!), false);
  assert.equal(f.store.get(item.taskId!)?.deliveryStatus, "skipped");
});

for (const origin of ["write", "lookup"] as const)
  test(
    "rate-limited " +
      origin +
      " fences only pending eyes of this installation across restart until the advertised deadline",
    (t) => {
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const f = open(t),
        first = f.observe(1),
        second = f.observe(2);
      const other = {
        installationId: 9,
        repositoryId: 80,
        owner: "org9",
        repo: "repo9",
      };
      const b = seedBinding(f.store, other, "phone");
      const task = f.store.observe({
        execute: true,
        reason: "mention",
        input: {
          ...first.input,
          ...other,
          bindingId: b.id,
          deliveryId: "foreign",
        },
      });
      f.store.confirmActivities("phone", fixtureAgent, f.b.id, [
        first.entry,
        second.entry,
      ]);
      f.store.confirmActivities("phone", fixtureAgent, b.id, [
        { deliveryId: "foreign", cursor: task.cursor },
      ]);
      assert.equal(f.store.reserveReaction()?.id, first.taskId);
      const retryAt = now + 3600_000;
      f.store.finishReaction(
        first.taskId!,
        origin === "write"
          ? { status: "failed", reason: "rate_limited", retryAt }
          : { status: "unknown", reason: "lookup_rate_limited", retryAt },
      );
      assert.equal(
        f.store.noteReactionLookupLimit(first.taskId!, now + 70_000),
        origin === "lookup",
      );
      assert.equal(
        f.store.noteReactionLookupLimit(second.taskId!, retryAt + 10_000),
        false,
      );
      const firstReceipt = f.store.ownerReceipt(
        first.entry.deliveryId,
      )?.reaction;
      assert.equal(
        firstReceipt?.reason,
        origin === "lookup" ? "lookup_rate_limited" : "rate_limited",
      );
      f.restart();
      assert.equal(f.store.reactionLookupRetryAt(first.taskId!), retryAt);
      assert.equal(f.store.reactionLookupRetryAt(second.taskId!), retryAt);
      assert.equal(f.store.reactionLookupRetryAt(task.taskId!), null);
      assert.equal(f.store.reserveReaction()?.id, task.taskId);
      f.store.finishReaction(task.taskId!, { status: "sent", reactionId: 77 });
      now = retryAt - 1;
      assert.equal(f.store.reserveReaction(), undefined);
      now++;
      assert.equal(f.store.reactionLookupRetryAt(first.taskId!), null);
      assert.equal(f.store.reserveReaction()?.id, second.taskId);
      assert.equal(
        f.store.ownerReceipt(first.entry.deliveryId)?.reaction?.status,
        origin === "write" ? "failed" : "unknown",
      );
      assert.equal(f.store.reserveReaction(), undefined);
    },
  );

test("ordinary comments remain traceable after retention and repeated installations cannot schedule duplicate writes", (t) => {
  const f = open(t),
    ordinary = f.observe(1, false),
    first = f.observe(2);
  f.store.confirmActivities("phone", fixtureAgent, f.b.id, [
    ordinary.entry,
    first.entry,
  ]);
  const next = { ...scope, installationId: 72 };
  const b = seedBinding(f.store, next, "phone");
  const later = f.store.observe({
    execute: true,
    reason: "mention",
    input: {
      ...first.input,
      ...next,
      bindingId: b.id,
      deliveryId: "new-installation",
    },
  });
  f.store.confirmActivities("phone", fixtureAgent, b.id, [
    { deliveryId: "new-installation", cursor: later.cursor },
  ]);
  const db = new DatabaseSync(f.path);
  try {
    db.exec("DELETE FROM activities");
  } finally {
    db.close();
  }
  assert.deepEqual(f.store.ownerReceiptForComment(99, 1), []);
  const [one] = f.store.ownerReceiptForComment(scope.repositoryId, 1);
  assert.deepEqual(
    [one.bindingId, one.commentId, one.reaction],
    [f.b.id, 1, null],
  );
  const history = f.store.ownerReceiptForComment(scope.repositoryId, 2);
  assert.deepEqual(
    history.map((h) => [h.bindingId, h.reaction?.status]),
    [
      [b.id, undefined],
      [f.b.id, "pending"],
    ],
  );
});
