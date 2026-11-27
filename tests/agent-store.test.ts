import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "../src/contracts.js";
import { StorageSchemaError } from "../src/store-schema.js";
import { AgentStore } from "../src/agent-store.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const task = (id: string): Task => ({
  id,
  deliveryId: id,
  bindingId: "b",
  installationId: 1,
  repositoryId: 2,
  owner: "org",
  repo: "repo",
  actorId: 3,
  actorLogin: "user",
  prompt: "do task",
  target: { kind: "issue", number: 4 },
  source: { event: "issues", action: "opened" },
  status: "running",
  deliveryStatus: "pending",
  createdAt: 1,
  error: null,
  outcome: null,
  runtime: null,
  publicationReceipt: null,
});

test("journal prevents duplicate execution and recovers running as unknown", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.db");
  let store = new AgentStore(path);
  const assignment = {
    task: task("a"),
    leaseToken: "lease",
    expiresAt: Date.now() + 50000,
  };
  assert.equal(store.begin(assignment), true);
  assert.equal(store.begin(assignment), false);
  assert.throws(() => new AgentStore(path), /already running/);
  store.close();
  store = new AgentStore(path);
  const pending = store.pending()!;
  assert.equal(JSON.parse(pending.result!).status, "unknown");
  assert.equal(store.begin(assignment), false);
  store.reported("a");
  assert.equal(store.pending(), undefined);
  assert.equal(store.begin(assignment), false);
  store.close();
});

test("terminated process lock is reclaimed and its execution becomes unknown", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  const script = `import {AgentStore} from ${JSON.stringify(pathToFileURL(resolve("src/agent-store.ts")).href)}; const s=new AgentStore(${JSON.stringify(path)});s.begin({task:${JSON.stringify(task("crash"))},leaseToken:'lease',expiresAt:Date.now()+60000});process.exit(0);`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
      "--input-type=module",
      "-e",
      script,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const store = new AgentStore(path);
  assert.equal(JSON.parse(store.pending()!.result!).status, "unknown");
  store.close();
});

test("old journal is rejected before recovery without altering rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "old-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.db");
  let db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE journal(id TEXT PRIMARY KEY,assignment TEXT NOT NULL,result TEXT,phase TEXT NOT NULL);INSERT INTO journal VALUES('old','{}',NULL,'running');",
  );
  db.close();
  assert.throws(() => new AgentStore(path), StorageSchemaError);
  db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT phase FROM journal").get()?.phase, "running");
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0);
  assert.equal(db.prepare("PRAGMA table_info(journal)").all().length, 4);
  db.close();
});
test("canonical outcome survives restart and is reported without reexecution", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "journal-outcome-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  let store = new AgentStore(path);
  const assignment = {
    task: task("result"),
    leaseToken: "lease",
    expiresAt: Date.now() + 60000,
  };
  store.begin(assignment);
  const result = {
    leaseToken: "lease",
    status: "succeeded" as const,
    outcome: {
      text: "done",
      artifacts: [],
      publication: { kind: "none" as const },
    },
  };
  store.finish("result", result);
  store.close();
  store = new AgentStore(path);
  assert.deepEqual(JSON.parse(store.pending()!.result!), result);
  assert.equal(store.begin(assignment), false);
  store.reported("result");
  assert.equal(store.pending(), undefined);
  store.close();
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
  db.close();
});

test("journal rejects flat or mixed legacy results", (t) => {
  const store = new AgentStore(":memory:");
  t.after(() => store.close());
  store.begin({
    task: task("a"),
    leaseToken: "lease",
    expiresAt: Date.now() + 60000,
  });
  for (const result of [
    { leaseToken: "lease", status: "succeeded", text: "old" },
    { leaseToken: "lease", status: "failed", text: "old" },
  ])
    assert.throws(() => store.finish("a", result as any));
  assert.equal(store.pending(), undefined);
  store.finish("a", { leaseToken: "lease", status: "failed" });
  assert.equal(JSON.parse(store.pending()!.result!).status, "failed");
});
