import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/store.js";

const scope = { installationId: 11, repositoryId: 22 };
const proof = {
  ...scope,
  owner: "org",
  repo: "repo",
  deviceId: "bridge-A",
  administratorId: 44,
};
const enabled = { enabled: true, events: ["push", "issue_comment.created"] };
const disabled = { enabled: false, events: [] };

test("retries are idempotent; a stale enable cannot undo a disable, including after restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "bindings.db");
  let db = new TaskStore(file);
  try {
    let registry = db.registry;
    const first = registry.apply(proof, 0, enabled);
    assert.equal(first.revision, 1);
    assert.deepEqual(
      registry.apply(proof, 0, {
        ...enabled,
        events: [...enabled.events].reverse(),
      }),
      first,
    );
    assert.deepEqual(registry.apply(proof, 1, enabled), first);
    const stopped = registry.apply(proof, 1, disabled);
    db.close();
    db = new TaskStore(file);
    registry = db.registry;
    assert.deepEqual(registry.get(scope), stopped);
    assert.throws(() => registry.apply(proof, 0, enabled), /revision/i);
    assert.throws(() => registry.apply(proof, 1, enabled), /revision/i);
    assert.deepEqual(registry.apply(proof, 1, disabled), stopped);
    assert.equal(registry.apply(proof, 2, enabled).revision, 3);
  } finally {
    db.close();
  }
});

test("a second device cannot use another binding, even with the latest revision or after disable", () => {
  const db = new TaskStore(":memory:");
  try {
    const registry = db.registry;
    registry.apply(proof, 0, enabled);
    const other = { ...proof, deviceId: "bridge-B" };
    assert.throws(() => registry.apply(other, 1, disabled), /device/i);
    registry.apply(proof, 1, disabled);
    assert.throws(() => registry.apply(other, 2, enabled), /device/i);
    assert.equal(
      registry.apply({ ...other, repositoryId: 23 }, 0, enabled).deviceId,
      "bridge-B",
    );
    assert.equal(registry.get(scope)?.enabled, false);
  } finally {
    db.close();
  }
});

test("invalid declarations and obsolete revisions cannot change the stored decision", () => {
  const db = new TaskStore(":memory:");
  try {
    const registry = db.registry;
    for (const value of [
      { enabled: true, events: [] },
      { enabled: true, events: ["unknown"] },
      { enabled: true, events: ["issues.labeled"] },
      { ...enabled, writePolicy: {} },
      { ...disabled, events: ["push"] },
    ])
      assert.throws(() => registry.apply(proof, 0, value));
    assert.equal(registry.get(scope), undefined);
    assert.throws(() => registry.apply(proof, 5, enabled), /revision/i);
    assert.throws(() => registry.apply(proof, 0, disabled));
    const first = registry.apply(proof, 0, {
      enabled: true,
      events: ["issues.labeled"],
      triggerLabel: "work",
    });
    assert.equal(first.triggerLabel, "work");
    assert.throws(() => registry.apply(proof, 0, enabled), /revision/i);
    assert.deepEqual(registry.get(scope), first);
  } finally {
    db.close();
  }
});

test("integrated task store refuses the retired registry without altering its contents or header", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "channel-old-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "old.db");
  let db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE bindings(value TEXT); INSERT INTO bindings VALUES ('keep'); PRAGMA application_id=1112097860; PRAGMA user_version=1;",
  );
  db.close();
  assert.throws(() => new TaskStore(file), /left intact/);
  db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare("SELECT value FROM bindings").get()?.value, "keep");
    assert.equal(
      db.prepare("PRAGMA application_id").get()?.application_id,
      1112097860,
    );
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
  } finally {
    db.close();
  }
});
