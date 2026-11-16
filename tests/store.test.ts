import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/store.js";
import type { NewTask } from "../src/contracts.js";
const input = (n = 1, bindingId = "one"): NewTask => ({
  deliveryId: `d${n}`,
  commentId: n,
  bindingId,
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "user",
  issueNumber: 4,
  prompt: "hello",
});
test("binding stays blocked across pending, sending and unknown delivery until operator reconciliation", (t) => {
  const { store } = fixture(t);
  const first = store.accept(input()).task;
  const next = store.accept(input(2)).task;
  store.claim();
  store.finish(first.id, "succeeded", "answer");
  assert.equal(store.claim(), undefined);
  assert.throws(() => store.resolveUnknownDelivery(first.id, "failed"));
  store.pendingDelivery();
  assert.equal(store.claim(), undefined);
  store.markDelivery(first.id, "unknown");
  assert.equal(store.claim(), undefined);
  const independent = store.accept(input(3, "independent")).task;
  assert.equal(store.claim()?.id, independent.id);
  assert.throws(() => store.resolveUnknownDelivery(first.id, "pending" as any));
  assert.equal(store.pendingDelivery(), undefined);
  store.resolveUnknownDelivery(
    first.id,
    "sent",
    "https://github.com/org/repo/issues/4#issuecomment-123",
  );
  assert.equal(store.get(first.id)?.deliveryStatus, "sent");
  assert.equal(
    store.get(first.id)?.commentUrl,
    "https://github.com/org/repo/issues/4#issuecomment-123",
  );
  assert.equal(store.claim()?.id, next.id);
  assert.equal(store.pendingDelivery(), undefined);
  assert.throws(() => store.resolveUnknownDelivery(first.id, "failed"));
});
test("recovered delivery ambiguity blocks binding and explicit failed resolution releases it without re-send", (t) => {
  const { store, path, stores } = fixture(t);
  const first = store.accept(input()).task;
  const next = store.accept(input(2)).task;
  store.claim();
  store.finish(first.id, "succeeded", "answer");
  store.pendingDelivery();
  store.close();
  const reopened = new TaskStore(path);
  stores.push(reopened);
  reopened.recover();
  assert.equal(reopened.claim(), undefined);
  assert.equal(reopened.pendingDelivery(), undefined);
  reopened.resolveUnknownDelivery(first.id, "failed");
  assert.equal(reopened.claim()?.id, next.id);
  assert.equal(reopened.pendingDelivery(), undefined);
});
test("remembers alternate delivery IDs even when later payloads change", (t) => {
  const { store } = fixture(t);
  const task = store.accept(input()).task;
  store.accept({ ...input(), deliveryId: "alternate" });
  const duplicate = store.accept({ ...input(99), deliveryId: "alternate" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.task.id, task.id);
});
test("independent database connections share claim and delivery reservations", (t) => {
  const { store, path, stores } = fixture(t);
  const peer = new TaskStore(path);
  stores.push(peer);
  const a = store.accept(input()).task;
  store.accept(input(2));
  assert.equal(peer.claim()?.id, a.id);
  assert.equal(store.claim(), undefined);
  peer.finish(a.id, "succeeded", "answer");
  assert.equal(store.pendingDelivery()?.id, a.id);
  assert.equal(peer.pendingDelivery(), undefined);
  peer.markDelivery(a.id, "unknown");
  assert.equal(store.pendingDelivery(), undefined);
});
test("unknown with a persisted result can be explicitly resolved to success", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  store.claim();
  store.finish(a.id, "unknown", "retained answer");
  store.resolveUnknown(a.id, "succeeded");
  assert.equal(store.pendingDelivery()?.result, "retained answer");
});
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "channel-store-"));
  const path = join(dir, "tasks.db");
  const store = new TaskStore(path);
  const stores = [store];
  t.after(() => {
    for (const db of stores) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path, stores };
}
test("deduplicates delivery and scoped comment without changing accepted payload", (t) => {
  const { store } = fixture(t);
  const first = store.accept(input());
  assert.equal(first.duplicate, false);
  assert.equal(
    store.accept({ ...input(2), deliveryId: "d1", prompt: "different" }).task
      .id,
    first.task.id,
  );
  assert.equal(
    store.accept({ ...input(), deliveryId: "redelivery" }).duplicate,
    true,
  );
  assert.equal(store.get(first.task.id)?.prompt, "hello");
  assert.equal(
    store.accept({ ...input(), deliveryId: "another", repositoryId: 9 })
      .duplicate,
    false,
  );
});
test("claims earliest queued and blocks running/unknown bindings while other bindings proceed", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  const b = store.accept(input(2)).task;
  const c = store.accept(input(3, "two")).task;
  assert.equal(store.claim()?.id, a.id);
  assert.equal(store.claim()?.id, c.id);
  store.finish(a.id, "unknown");
  assert.equal(store.claim(), undefined);
  store.resolveUnknown(a.id, "failed");
  assert.equal(store.claim()?.id, b.id);
});
test("rejects illegal state transitions and success without result atomically", (t) => {
  const { store } = fixture(t);
  const task = store.accept(input()).task;
  assert.throws(() => store.finish(task.id, "succeeded", "bad"));
  store.claim();
  assert.throws(() => store.finish(task.id, "queued"));
  assert.throws(() => store.finish(task.id, "succeeded"));
  assert.equal(store.get(task.id)?.status, "running");
  store.finish(task.id, "succeeded", "answer", undefined, "response");
  assert.equal(store.get(task.id)?.responseId, "response");
  assert.throws(() => store.finish(task.id, "failed"));
  assert.throws(() => store.resolveUnknown(task.id, "failed"));
});
test("persists results and reserves each reply once; sent replies are never replayed", (t) => {
  const { store } = fixture(t);
  const task = store.accept(input()).task;
  assert.equal(store.pendingDelivery(), undefined);
  store.claim();
  store.finish(task.id, "succeeded", "answer");
  assert.equal(store.pendingDelivery()?.result, "answer");
  assert.equal(store.pendingDelivery(), undefined);
  store.markDelivery(task.id, "sent", "https://github.com/comment");
  assert.equal(store.get(task.id)?.commentUrl, "https://github.com/comment");
  assert.throws(() => store.markDelivery(task.id, "pending"));
  store.recover();
  assert.equal(store.pendingDelivery(), undefined);
});
test("restart recovery preserves queued work and marks execution/delivery ambiguity without replay", (t) => {
  const { store, path, stores } = fixture(t);
  const a = store.accept(input()).task;
  const b = store.accept(input(2)).task;
  const c = store.accept(input(3, "two")).task;
  store.claim();
  store.claim();
  store.finish(c.id, "succeeded", "saved");
  store.pendingDelivery();
  store.close();
  const reopened = new TaskStore(path);
  stores.push(reopened);
  reopened.recover();
  assert.equal(reopened.get(a.id)?.status, "unknown");
  assert.equal(reopened.get(b.id)?.status, "queued");
  assert.equal(reopened.get(c.id)?.deliveryStatus, "unknown");
  assert.equal(reopened.pendingDelivery(), undefined);
  assert.equal(reopened.claim(), undefined);
  assert.throws(() => reopened.resolveUnknown(a.id, "succeeded"));
  reopened.resolveUnknown(a.id, "failed");
  assert.equal(reopened.claim()?.id, b.id);
});
