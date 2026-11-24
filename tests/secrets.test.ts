import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveSecrets } from "../src/secrets.js";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "channel-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = {
    server: { host: "127.0.0.1", port: 3000, adminTokenFile: "admin" },
    dataFile: "data.db",
    github: {
      appId: "123",
      privateKeyFile: "app.pem",
      webhookSecretFile: "hook",
      botLogin: "test[bot]",
    },
    connector: {
      timeoutMs: 1000,
    },
  };
  const pem =
    "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n";
  for (const [name, value] of Object.entries({
    "app.pem": pem,
    admin: "admin-secret\n",
    hook: "hook-secret\n",
  }))
    writeFileSync(join(dir, name), value);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return { dir, config, path, pem };
}

test("file secret references load relative to configuration, not process cwd, without entering loaded configuration", (t) => {
  const { path, config } = fixture(t);
  const result = loadConfig(path, {});
  assert.deepEqual(result, config);
  assert.equal(JSON.stringify(result).includes("admin-secret"), false);
});

test("configuration rejects ambiguous env and file secret references", (t) => {
  const { path, config } = fixture(t);
  Object.assign(config.github, { privateKeyEnv: "KEY" });
  writeFileSync(path, JSON.stringify(config));
  assert.throws(
    () => loadConfig(path, { KEY: "must-not-appear" }),
    (e) => {
      assert.match(String(e), /github.privateKey/);
      assert.doesNotMatch(String(e), /must-not-appear/);
      return true;
    },
  );
});

test("missing and blank secret files fail with a field diagnostic, not file contents", (t) => {
  const { path, dir } = fixture(t);
  writeFileSync(join(dir, "hook"), " \n");
  assert.throws(() => loadConfig(path, {}), /github.webhookSecret/);
  rmSync(join(dir, "hook"));
  assert.throws(() => loadConfig(path, {}), /github.webhookSecret/);
});

test("resolved file secrets preserve PEM newlines and remove token file trailing whitespace", (t) => {
  const { config, path, pem } = fixture(t);
  assert.deepEqual(resolveSecrets(config, path, {}), {
    privateKey: pem,
    adminToken: "admin-secret",
    webhookSecret: "hook-secret",
  });
});
