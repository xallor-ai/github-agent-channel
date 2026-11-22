import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigManager } from "../src/config.js";
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
      tokenFile: "token",
      workerId: "local-worker",
      timeoutMs: 1000,
    },
    bindings: [],
  };
  const pem =
    "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n";
  for (const [name, value] of Object.entries({
    "app.pem": pem,
    admin: "admin-secret\n",
    hook: "hook-secret\n",
    token: "runtime-secret\n",
  }))
    writeFileSync(join(dir, name), value);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return { dir, config, path, pem };
}

test("file secret references load relative to configuration, not process cwd, without entering snapshots", (t) => {
  const { path, config } = fixture(t);
  const result = loadConfig(path, {});
  assert.deepEqual(result, config);
  assert.equal(
    JSON.stringify(new ConfigManager(path, {}).snapshot()).includes(
      "admin-secret",
    ),
    false,
  );
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

test("invalid file secret update keeps the config and revision intact", (t) => {
  const { path, config } = fixture(t);
  const manager = new ConfigManager(path, {});
  const before = manager.snapshot();
  config.connector.tokenFile = "absent";
  assert.throws(() => manager.update(config, 1), /connector.token/);
  assert.deepEqual(manager.snapshot(), before);
  assert.deepEqual(loadConfig(path, {}), before.config);
});

test("resolved file secrets preserve PEM newlines and remove token file trailing whitespace", (t) => {
  const { config, path, pem } = fixture(t);
  assert.deepEqual(resolveSecrets(config, path, {}), {
    privateKey: pem,
    adminToken: "admin-secret",
    webhookSecret: "hook-secret",
    connectorToken: "runtime-secret",
  });
});

test("valid file reference update resolves against the original configuration directory", (t) => {
  const { config, dir, path } = fixture(t);
  const manager = new ConfigManager(path, {});
  writeFileSync(join(dir, "new-token"), "replacement-secret\n");
  config.connector.tokenFile = "new-token";
  assert.equal(manager.update(config, 1).revision, 2);
  assert.equal(
    resolveSecrets(loadConfig(path, {}), path, {}).connectorToken,
    "replacement-secret",
  );
});
