import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "../src/agent-store.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

test("journal prevents duplicate execution and recovers running as unknown", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.db");
  let store = new AgentStore(path);
  const assignment = {
    task: { id: "a" },
    leaseToken: "lease",
    expiresAt: Date.now() + 50000,
  } as any;
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
  const script = `import {AgentStore} from ${JSON.stringify(pathToFileURL(resolve("src/agent-store.ts")).href)}; const s=new AgentStore(${JSON.stringify(path)});s.begin({task:{id:'crash'},leaseToken:'lease',expiresAt:Date.now()+60000});process.exit(0);`;
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
