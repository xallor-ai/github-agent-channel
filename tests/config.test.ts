import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.js";
const env = {
  ADMIN: "secret-admin",
  KEY: "secret-key",
  HOOK: "secret-hook",
};
function config() {
  return {
    server: { host: "127.0.0.1", port: 3000, adminTokenEnv: "ADMIN" },
    dataFile: "data/tasks.db",
    github: {
      appId: "123",
      privateKeyEnv: "KEY",
      webhookSecretEnv: "HOOK",
      botLogin: "agent[bot]",
    },
    connector: {
      timeoutMs: 60000,
    },
  };
}
function fixture(t: any, yaml = false) {
  const dir = mkdtempSync(join(tmpdir(), "channel-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, yaml ? "config.yaml" : "config.json");
  writeFileSync(path, yaml ? stringify(config()) : JSON.stringify(config()));
  return path;
}
test("loads JSON and YAML without exposing resolved secrets", (t) => {
  for (const yaml of [false, true]) {
    const value = loadConfig(fixture(t, yaml), env);
    assert.deepEqual(value, config());
    assert.equal(JSON.stringify(value).includes("secret-"), false);
  }
});
test("rejects unknown fields, missing env, obsolete credentials and duplicate write profiles, unsafe URLs and invalid bounds", (t) => {
  const path = fixture(t);
  const invalid: any[] = [];
  for (const patch of [
    { workerId: "retired" },
    { tokenEnv: "TOKEN" },
    { tokenFile: "legacy" },
    { token: "plain-secret" },
    { timeoutMs: 0 },
    { timeoutMs: 3_600_001 },
    { maxToolRounds: 0 },
    { baseUrl: "file:///etc/passwd" },
    { baseUrl: "https://user:pass@example.org" },
  ]) {
    const c = config();
    Object.assign(c.connector, patch);
    invalid.push(c);
  }
  invalid.push({ ...config(), bindings: [] });
  const profile = {
    installationId: 1,
    repositoryId: 2,
    policy: { baseBranch: "main", allowedPaths: ["src/"] },
  };
  invalid.push({ ...config(), writeProfiles: [profile, profile] });
  const extra = { ...config(), privateKey: "plain-secret" };
  invalid.push(extra);
  for (const c of invalid) {
    writeFileSync(path, JSON.stringify(c));
    assert.throws(() => loadConfig(path, env));
  }
  writeFileSync(path, JSON.stringify(config()));
  assert.throws(() => loadConfig(path, { ...env, HOOK: "" }));
});

test("accepts deployment mode and rejects public URLs that are not HTTPS origins", (t) => {
  const path = fixture(t);
  const c = config() as any;
  c.deployment = { mode: "caddy", publicUrl: "https://channel.example.com" };
  writeFileSync(path, JSON.stringify(c));
  assert.equal(loadConfig(path, env).deployment?.mode, "caddy");
  for (const url of [
    "http://channel.example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
  ]) {
    c.deployment.publicUrl = url;
    writeFileSync(path, JSON.stringify(c));
    assert.throws(() => loadConfig(path, env));
  }
});

test("startup reports incompatible storage without exposing config secrets", (t) => {
  const path = fixture(t);
  const database = path + ".db";
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY)");
  db.close();
  writeFileSync(path, JSON.stringify({ ...config(), dataFile: database }));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/main.ts"],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ...env, CHANNEL_CONFIG: path },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Storage schema version 3 required/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /secret-admin|secret-key|secret-hook|secret-token/,
  );
});
