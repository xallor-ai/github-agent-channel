import { seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/store.js";
import type { NewTask } from "../src/contracts.js";
const input: NewTask = {
  deliveryId: "d1",
  source: { event: "issue_comment", action: "created", commentId: 1 },
  bindingId: "1:2:worker:1",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "user",
  target: { kind: "issue", number: 4 },
  prompt: "hello",
};
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pull-store-"));
  const path = join(dir, "tasks.db");
  const stores: TaskStore[] = [];
  t.after(() => {
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const s = new TaskStore(path);
    seedBinding(s, input, "worker");
    stores.push(s);
    return s;
  };
  return { open };
}
test("assignment is atomic across connections and blocks one worker across bindings", (t) => {
  const { open } = fixture(t);
  const s = open(),
    peer = open();
  const a = s.accept(input).task;
  seedBinding(s, { ...input, repositoryId: 3 }, "worker");
  s.accept({
    ...input,
    deliveryId: "d2",
    source: { ...input.source, commentId: 2 },
    repositoryId: 3,
    bindingId: "1:3:worker:1",
  });
  const lease = s.claimAssignment("worker", "hash", 2000, 1000);
  assert.equal(lease?.id, a.id);
  assert.equal(peer.claimAssignment("worker", "other", 2000, 1000), undefined);
  assert.equal(
    peer.assignedTask(a.id, "other-worker", "hash", 1000),
    undefined,
  );
  assert.equal(peer.assignedTask(a.id, "worker", "wrong", 1000), undefined);
  assert.equal(peer.assignedTask(a.id, "worker", "hash", 1000)?.id, a.id);
});
test("expiry and restart never replay execution or allow late success", (t) => {
  const { open } = fixture(t);
  const s = open();
  const a = s.accept(input).task;
  s.claimAssignment("worker", "hash", 2000, 1000);
  s.expireTasks(2000);
  assert.equal(s.get(a.id)?.status, "unknown");
  assert.equal(s.claimAssignment("worker", "new", 4000, 2000), undefined);
  assert.throws(() =>
    s.finishAssignment(
      a.id,
      "worker",
      "hash",
      {
        status: "succeeded",
        outcome: {
          text: "late",
          artifacts: [],
          publication: { kind: "comment" },
        },
      },
      "digest",
      2000,
    ),
  );
  s.resolveUnknown(a.id, "failed");
  const b = s.accept({
    ...input,
    deliveryId: "d2",
    source: { ...input.source, commentId: 2 },
  }).task;
  s.claimAssignment("worker", "hash2", 4000, 3000);
  s.close();
  const restarted = open();
  restarted.recover();
  assert.equal(restarted.get(b.id)?.status, "unknown");
  assert.equal(
    restarted.assignedTask(b.id, "worker", "hash2", 3001),
    undefined,
  );
});
test("result and digest commit together, identical retry persists across restart, conflict rejected", (t) => {
  const { open } = fixture(t);
  const s = open();
  const a = s.accept(input).task;
  s.claimAssignment("worker", "hash", 2000, 1000);
  const result = {
    status: "succeeded" as const,
    outcome: {
      text: "answer",
      responseId: "r1",
      artifacts: [],
      publication: { kind: "comment" as const },
    },
  };
  assert.equal(
    s.finishAssignment(a.id, "worker", "hash", result, "same", 1500),
    false,
  );
  assert.equal(s.get(a.id)?.outcome?.text, "answer");
  s.close();
  const peer = open();
  peer.recover();
  assert.equal(
    peer.finishAssignment(a.id, "worker", "hash", result, "same", 3000),
    true,
  );
  assert.throws(() =>
    peer.finishAssignment(
      a.id,
      "worker",
      "hash",
      { status: "failed" },
      "different",
      3000,
    ),
  );
  assert.throws(() =>
    peer.finishAssignment(a.id, "worker", "wrong", result, "same", 3000),
  );
  assert.equal(peer.get(a.id)?.status, "succeeded");
  assert.equal(peer.pendingDelivery()?.id, a.id);
  assert.equal(peer.pendingDelivery(), undefined);
});
test("offline queue expires at 24h from first acceptance; redelivery does not reset its age", (t) => {
  const s = fixture(t).open();
  const original = s.accept(input).task;
  const cutoff = original.createdAt + 86_400_000;
  assert.equal(s.accept(input).task.createdAt, original.createdAt);
  assert.equal(
    s.claimAssignment("worker", "lease", cutoff + 1000, cutoff),
    undefined,
  );
  assert.equal(s.get(original.id)?.status, "rejected");
  assert.equal(s.get(original.id)?.deliveryStatus, "skipped");
  assert.equal(s.accept(input).task.status, "rejected");
});
test("offline work can still be claimed just before expiry; queue timeout never cancels running work", (t) => {
  const s = fixture(t).open();
  const a = s.accept(input).task;
  const cutoff = a.createdAt + 86_400_000;
  assert.equal(
    s.claimAssignment("worker", "lease", cutoff + 500, cutoff - 1)?.id,
    a.id,
  );
  s.expireTasks(cutoff);
  assert.equal(s.get(a.id)?.status, "running");
});
