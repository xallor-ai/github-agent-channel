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
  assert.equal(f.store.ownerReceipt(a.entry.deliveryId)?.reaction, null);
  const first = f.store.ownerReceipt("d2");
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
