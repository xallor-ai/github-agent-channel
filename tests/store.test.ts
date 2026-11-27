import { fixtureAgent, seedBinding } from "./binding-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorageSchemaError } from "../src/store-schema.js";
import { TaskStore } from "../src/store.js";
import type { NewTask, RuntimeResult } from "../src/contracts.js";
const input = (n = 1, repositoryId = 2): NewTask => ({
  deliveryId: `d${n}`,
  bindingId: `1:${repositoryId}:${repositoryId === 3 ? "w2" : "w"}:1`,
  installationId: 1,
  repositoryId,
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
  for (const n of [2, 3, 9])
    seedBinding(store, input(1, n), n === 3 ? "w2" : "w", [
      "issue_comment.created",
      "push",
    ]);
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
    store.accept({ ...input(1, 9), deliveryId: "other" }).duplicate,
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
test("pre-dispatch rejection requires the matching reservation", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  assert.throws(() =>
    store.rejectUndeliveredClaim(a.id, "w", "h", "rejected", "denied"),
  );
  store.claimAssignment("w", "h", 2000, 1000);
  store.rejectUndeliveredClaim(a.id, "w", "h", "rejected", "denied");
  assert.equal(store.get(a.id)?.status, "rejected");
  assert.equal(store.get(a.id)?.error, "denied");
  assert.throws(() =>
    store.rejectUndeliveredClaim(a.id, "w", "h", "failed", "again"),
  );
});
test("restart preserves queued work and blocks unknown execution and delivery", (t) => {
  const { store, path, stores } = fixture(t);
  const a = store.accept(input()).task;
  const b = store.accept(input(2)).task;
  const c = store.accept(input(3, 3)).task;
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
test("fresh schema is version 8 and contains no legacy columns", (t) => {
  const { path } = fixture(t);
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
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

test("a concurrent declaration change fences old work in the same durable queue and denies stale acceptance", (t) => {
  const { store, path, stores } = fixture(t);
  const peer = new TaskStore(path);
  stores.push(peer);
  const current = input();
  assert.equal(store.claimAssignment("alien", "h", 2000, 1000), undefined);
  const running = store.accept(current).task;
  const queued = store.accept(input(2)).task;
  assert.equal(store.claimAssignment("alien", "h", 2000, 1000), undefined);
  assert.equal(store.claimAssignment("w", "h", 2000, 1000)?.id, running.id);
  const { owner, repo, installationId, repositoryId } = current;
  const proof = {
    owner,
    repo,
    installationId,
    repositoryId,
    deviceId: "w",
    administratorId: 44,
  };
  peer.registry.apply(proof, 1, { enabled: false, events: [] });
  assert.equal(store.activeBinding(installationId, repositoryId), undefined);
  assert.equal(store.get(queued.id)?.status, "rejected");
  assert.equal(store.get(running.id)?.status, "unknown");
  assert.equal(store.assignedTask(running.id, "w", "h", 1001), undefined);
  assert.throws(() =>
    store.finishAssignment(
      running.id,
      "w",
      "h",
      { status: "succeeded", outcome },
      "late",
      1001,
    ),
  );
  peer.registry.apply(proof, 2, {
    enabled: true,
    responsibleAgent: fixtureAgent,
    events: ["push"],
  });
  const binding = store.activeBinding(installationId, repositoryId)!;
  assert.notEqual(binding.id, current.bindingId);
  assert.throws(
    () => store.accept({ ...input(4), bindingId: binding.id }),
    /Binding/,
  );
  assert.throws(() => store.accept(input(3)), /Binding/);
  const newTask = store.accept({
    ...input(3),
    bindingId: binding.id,
    source: { event: "push" },
    target: { kind: "repository" },
  }).task;
  assert.equal(store.claimAssignment("w", "h2", 2000, 1001), undefined);
  store.resolveUnknown(running.id, "failed");
  assert.equal(store.claimAssignment("w", "h2", 2000, 1001)?.id, newTask.id);
});

test("device revocation stops pending publication and denies previously verified registrations after restart", (t) => {
  const { store, path, stores } = fixture(t);
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
  store.registry.revokeDevice("w");
  store.close();
  const peer = new TaskStore(path);
  stores.push(peer);
  assert.equal(peer.get(a.id)?.deliveryStatus, "skipped");
  assert.equal(peer.pendingDelivery(), undefined);
  assert.throws(() =>
    peer.finishAssignment(
      a.id,
      "w",
      "h",
      { status: "succeeded", outcome },
      "done",
      1001,
    ),
  );
  assert.throws(
    () =>
      peer.registry.apply(
        {
          installationId: 2,
          repositoryId: 200,
          owner: "org",
          repo: "new",
          administratorId: 3,
          deviceId: "w",
        },
        0,
        { enabled: true, responsibleAgent: fixtureAgent, events: ["push"] },
      ),
    /revoked/,
  );
  assert.equal(peer.activeBinding(1, 3)?.deviceId, "w2");
});

test("a binding change cannot cancel an issued publication or admit the next revision until its receipt is reconciled", (t) => {
  const { store } = fixture(t);
  const first = store.accept(input()).task;
  store.claimAssignment("w", "lease", 2000, 1000);
  store.finishAssignment(
    first.id,
    "w",
    "lease",
    { status: "succeeded", outcome },
    "done",
    1001,
  );
  assert.equal(store.pendingDelivery()?.id, first.id);
  const proof = {
    deviceId: "w",
    administratorId: 44,
    installationId: 1,
    repositoryId: 2,
    owner: "org",
    repo: "repo",
  };
  store.registry.apply(proof, 1, {
    enabled: true,
    responsibleAgent: fixtureAgent,
    events: ["issue_comment.created"],
  });
  const binding = store.activeBinding(1, 2)!;
  const next = store.accept({ ...input(2), bindingId: binding.id }).task;
  assert.equal(store.get(first.id)?.deliveryStatus, "sending");
  assert.equal(store.claimAssignment("w", "next", 2000, 1001), undefined);
  store.markDelivery(first.id, "unknown");
  assert.equal(store.claimAssignment("w", "next", 2000, 1001), undefined);
  const receipt = {
    kind: "comment" as const,
    id: 812,
    url: "https://github.com/org/repo/issues/4#issuecomment-812",
  };
  store.resolveUnknownDelivery(first.id, "sent", receipt);
  assert.deepEqual(store.get(first.id)?.publicationReceipt, receipt);
  assert.equal(store.claimAssignment("w", "next", 2000, 1001)?.id, next.id);
});

test("cloud tool counters persist across connections and restart without changing runtime evidence", (t) => {
  const { store, path, stores } = fixture(t);
  const peer = new TaskStore(path);
  stores.push(peer);
  const task = store.accept(input()).task;
  assert.deepEqual(store.toolAudit(task.id), []);
  assert.throws(() => store.recordToolCall(task.id, "read_file", "requested"));
  store.claimAssignment("w", "h", 2000, 1000);
  assert.throws(() =>
    store.recordToolCall(task.id, "read_file", "failed", "unknown"),
  );
  store.recordToolCall(task.id, "read_file", "requested");
  peer.recordToolCall(task.id, "read_file", "requested");
  assert.throws(() =>
    store.recordToolCall(
      task.id,
      "read_file",
      "failed",
      "private raw failure" as never,
    ),
  );
  peer.recordToolCall(task.id, "read_file", "failed", "scope");
  store.recordToolCall(task.id, "read_file", "succeeded");
  // A third request was initiated, but no terminal observation was made.
  peer.recordToolCall(task.id, "read_file", "requested");
  assert.throws(() =>
    store.recordToolCall(task.id, "secret-token-as-name" as never, "requested"),
  );
  assert.throws(() =>
    store.recordToolCall(
      task.id,
      "read_file",
      "secret-token-as-phase" as never,
    ),
  );
  assert.equal(store.get(task.id)?.runtime, null);
  store.close();
  peer.close();
  const reopened = new TaskStore(path);
  stores.push(reopened);
  const [audit] = reopened.toolAudit(task.id);
  assert.deepEqual(
    [audit.name, audit.requested, audit.succeeded, audit.failed],
    ["read_file", 3, 1, 1],
  );
  assert.ok(audit.firstRequestedAt <= audit.lastRequestedAt);
  assert.ok(audit.lastSucceededAt && audit.lastFailedAt);
  assert.equal(audit.lastFailure, "scope");
  assert.deepEqual(
    Object.keys(audit).sort(),
    [
      "name",
      "requested",
      "succeeded",
      "failed",
      "firstRequestedAt",
      "lastRequestedAt",
      "lastSucceededAt",
      "lastFailedAt",
      "lastFailure",
      "buildSha",
    ].sort(),
  );
});
test("comment audit lookup stays scoped to a repository and triggering comment", (t) => {
  const { store } = fixture(t);
  const a = store.accept(input()).task;
  const b = store.accept({
    ...input(1, 3),
    deliveryId: "other-repo-delivery",
  }).task;
  assert.equal(store.taskForComment(2, 1)?.id, a.id);
  assert.equal(store.taskForComment(3, 1)?.id, b.id);
  assert.equal(store.taskForComment(9, 1), undefined);
});
test("the audit records only a full server build SHA; invalid values never enter the receipt", (t) => {
  const previous = process.env.CHANNEL_BUILD_SHA;
  t.after(() => {
    if (previous === undefined) delete process.env.CHANNEL_BUILD_SHA;
    else process.env.CHANNEL_BUILD_SHA = previous;
  });
  for (const value of ["a".repeat(40), "not-a-sha-or-secret"]) {
    process.env.CHANNEL_BUILD_SHA = value;
    const { store } = fixture(t);
    const task = store.accept(input()).task;
    store.claimAssignment("w", "h", 2000, 1000);
    store.recordToolCall(task.id, "read_issue", "requested");
    assert.equal(
      store.toolAudit(task.id)[0].buildSha,
      value.length === 40 ? value : null,
    );
  }
});

test("an incompatible companion audit database is rejected without dropping its data or changing the v8 tasks", (t) => {
  const { path, store } = fixture(t);
  const task = store.accept(input()).task;
  store.close();
  const sidecar = path + ".tool-audit.sqlite";
  const db = new DatabaseSync(sidecar);
  try {
    db.exec(
      "PRAGMA user_version=1; ALTER TABLE toolAudit DROP COLUMN lastFailure; INSERT INTO toolAudit(taskId,name,requested,succeeded,failed,firstRequestedAt,lastRequestedAt) VALUES ('historical','read_file',1,0,1,1000,1000)",
    );
  } finally {
    db.close();
  }
  assert.throws(() => new TaskStore(path), StorageSchemaError);
  const audit = new DatabaseSync(sidecar);
  const tasks = new DatabaseSync(path);
  try {
    assert.equal(
      audit
        .prepare("SELECT failed FROM toolAudit WHERE taskId='historical'")
        .get()?.failed,
      1,
    );
    assert.equal(
      tasks.prepare("SELECT status FROM tasks WHERE id=?").get(task.id)?.status,
      "queued",
    );
    assert.equal(tasks.prepare("PRAGMA user_version").get()?.user_version, 8);
  } finally {
    audit.close();
    tasks.close();
  }
});
