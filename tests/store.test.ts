import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorageSchemaError } from "../src/store-schema.js";
import { TaskStore } from "../src/store.js";
import type { NewTask, RuntimeResult } from "../src/contracts.js";
const input = (n = 1, bindingId = "one"): NewTask => ({
  deliveryId: `d${n}`,
  bindingId,
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "user",
  prompt: "hello",
  target: { kind: "issue", number: 4 },
  source: { event: "issue_comment", action: "created", commentId: n },
});
const outcome: RuntimeResult = {
  text: "answer",
  artifacts: [],
  publication: { kind: "comment" },
  responseId: "response",
};
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "channel-store-"));
  const path = join(dir, "tasks.db");
  const store = new TaskStore(path);
  const stores = [store];
  t.after(() => {
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path, stores };
}
test("binding remains blocked across publication ambiguity until receipt reconciliation", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  const b = store.accept(input(2)).task;
  store.claimAssignment("w", "h", 2000, 1000);
  store.finishAssignment(
    a.id,
    "w",
    "h",
    { status: "succeeded", outcome },
    "d",
    1001,
  );
  assert.equal(store.claimAssignment("w", "h2", 2000, 1001), undefined);
  assert.throws(() => store.resolveUnknownDelivery(a.id, "failed"));
  assert.equal(store.pendingDelivery()?.outcome?.text, "answer");
  assert.equal(store.pendingDelivery(), undefined);
  store.markDelivery(a.id, "unknown");
  assert.equal(store.claimAssignment("w", "h2", 2000, 1001), undefined);
  const receipt = {
    kind: "comment" as const,
    id: 123,
    url: "https://github.com/org/repo/issues/4#issuecomment-123",
  };
  store.resolveUnknownDelivery(a.id, "sent", receipt);
  assert.deepEqual(store.get(a.id)?.publicationReceipt, receipt);
  assert.equal(store.claimAssignment("w", "h2", 2000, 1001)?.id, b.id);
  assert.equal(store.pendingDelivery(), undefined);
});
test("deduplicates scoped comment and retains alternate delivery IDs", (t) => {
  const { store } = fixture(t);
  const first = store.accept(input()).task;
  assert.equal(
    store.accept({ ...input(), deliveryId: "alternate" }).duplicate,
    true,
  );
  assert.equal(
    store.accept({ ...input(99), deliveryId: "alternate" }).task.id,
    first.id,
  );
  assert.equal(
    store.accept({ ...input(), deliveryId: "other", repositoryId: 9 })
      .duplicate,
    false,
  );
  assert.equal(store.get(first.id)?.prompt, "hello");
  assert.equal("commentId" in first, false);
  assert.equal("issueNumber" in first, false);
});
test("non-comment events use delivery identity and canonical null fields", (t) => {
  const { store } = fixture(t);
  const a = store.accept({
    ...input(),
    source: { event: "push" },
    target: { kind: "repository" },
  }).task;
  const b = store.accept({
    ...input(2),
    source: { event: "push" },
    target: { kind: "repository" },
  }).task;
  assert.notEqual(a.id, b.id);
  assert.equal(a.outcome, null);
  assert.equal(a.runtime, null);
  assert.equal(a.publicationReceipt, null);
  assert.equal(a.error, null);
});
test("rejectAssignment only terminates a running assignment", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  assert.throws(() => store.rejectAssignment(a.id, "rejected", "denied"));
  store.claimAssignment("w", "h", 2000, 1000);
  store.rejectAssignment(a.id, "rejected", "denied");
  assert.equal(store.get(a.id)?.status, "rejected");
  assert.equal(store.get(a.id)?.error, "denied");
  assert.throws(() => store.rejectAssignment(a.id, "failed", "again"));
});
test("restart preserves queued work and blocks unknown execution and delivery", (t) => {
  const { store, path, stores } = fixture(t);
  const a = store.accept(input()).task;
  const b = store.accept(input(2)).task;
  const c = store.accept(input(3, "two")).task;
  store.claimAssignment("w", "h", 2000, 1000);
  store.claimAssignment("w2", "h2", 2000, 1000);
  store.finishAssignment(
    c.id,
    "w2",
    "h2",
    { status: "succeeded", outcome },
    "d",
    1001,
  );
  store.pendingDelivery();
  store.close();
  const reopened = new TaskStore(path);
  stores.push(reopened);
  reopened.recover();
  assert.equal(reopened.get(a.id)?.status, "unknown");
  assert.equal(reopened.get(b.id)?.status, "queued");
  assert.equal(reopened.get(c.id)?.deliveryStatus, "unknown");
  assert.equal(reopened.pendingDelivery(), undefined);
  assert.throws(() => reopened.resolveUnknown(a.id, "succeeded" as any));
  reopened.resolveUnknown(a.id, "failed");
  assert.equal(reopened.claimAssignment("w", "new", 3000, 1002)?.id, b.id);
  reopened.resolveUnknownDelivery(c.id, "failed");
  assert.equal(reopened.pendingDelivery(), undefined);
});
test("fresh schema is version 2 and contains no legacy columns", (t) => {
  const { path } = fixture(t);
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    const columns = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((r) => r.name);
    for (const c of [
      "commentId",
      "issueNumber",
      "result",
      "responseId",
      "commentUrl",
      "publicationUrl",
    ])
      assert.equal(columns.includes(c), false);
    assert.ok(columns.includes("publicationReceipt"));
  } finally {
    db.close();
  }
});
test("old schema is rejected without changing its data or version", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.db");
  let db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY, result TEXT);INSERT INTO tasks VALUES('old','retained');",
  );
  db.close();
  assert.throws(() => new TaskStore(path), StorageSchemaError);
  db = new DatabaseSync(path);
  assert.equal(
    db.prepare("SELECT result FROM tasks").get()?.result,
    "retained",
  );
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0);
  db.close();
});

test("invalid and legacy assignment results are rejected atomically", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  store.claimAssignment("w", "h", 2000, 1000);
  for (const result of [
    { status: "succeeded", text: "legacy" },
    { status: "failed", text: "legacy" },
    { status: "unknown", outcome },
    {
      status: "succeeded",
      outcome: { text: "", artifacts: [], publication: { kind: "none" } },
    },
  ]) {
    assert.throws(() =>
      store.finishAssignment(a.id, "w", "h", result as any, "bad", 1001),
    );
    assert.equal(store.get(a.id)?.status, "running");
    assert.equal(store.get(a.id)?.outcome, null);
  }
  store.finishAssignment(a.id, "w", "h", { status: "failed" }, "valid", 1002);
  assert.equal(store.get(a.id)?.status, "failed");
});
test("runtime handle persists and conflicting handle is rejected", (t) => {
  const { store, path, stores } = fixture(t);
  const a = store.accept(input()).task;
  const runtime = { kind: "started" as const, provider: "acp", runId: "r1" };
  assert.throws(() => store.recordRuntime(a.id, runtime));
  store.claimAssignment("w", "h", 2000, 1000);
  store.recordRuntime(a.id, runtime);
  store.recordRuntime(a.id, runtime);
  assert.throws(() => store.recordRuntime(a.id, { ...runtime, runId: "r2" }));
  store.close();
  const reopened = new TaskStore(path);
  stores.push(reopened);
  reopened.recover();
  assert.deepEqual(reopened.get(a.id)?.runtime, runtime);
  assert.equal(reopened.get(a.id)?.status, "unknown");
});
test("independent connections reserve publication once and preserve sent receipt", (t) => {
  const { store, path, stores } = fixture(t);
  const peer = new TaskStore(path);
  stores.push(peer);
  const a = store.accept(input()).task;
  store.claimAssignment("w", "h", 2000, 1000);
  store.finishAssignment(
    a.id,
    "w",
    "h",
    { status: "succeeded", outcome },
    "done",
    1001,
  );
  assert.equal(peer.pendingDelivery()?.id, a.id);
  assert.equal(store.pendingDelivery(), undefined);
  const receipt = {
    kind: "comment" as const,
    url: "https://github.com/comment",
  };
  peer.markDelivery(a.id, "sent", receipt);
  assert.deepEqual(store.get(a.id)?.publicationReceipt, receipt);
  assert.throws(() => store.markDelivery(a.id, "sent", receipt));
  store.recover();
  assert.equal(store.pendingDelivery(), undefined);
});

test("unknown execution cannot be promoted to success even with a retained outcome", (t) => {
  const { store, path } = fixture(t);
  const task = store.accept(input()).task;
  store.claimAssignment("w", "h", 2000, 1000);
  store.recover();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE tasks SET outcome=? WHERE id=?").run(
    JSON.stringify(outcome),
    task.id,
  );
  db.close();
  assert.throws(
    () => store.resolveUnknown(task.id, "succeeded" as any),
    /Invalid resolution/,
  );
  assert.equal(store.get(task.id)?.status, "unknown");
  assert.equal(store.pendingDelivery(), undefined);
  store.resolveUnknown(task.id, "failed");
  assert.equal(store.get(task.id)?.status, "failed");
});
