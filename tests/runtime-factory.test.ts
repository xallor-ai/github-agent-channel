import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime-factory.js";
import { loadAgentConfig } from "../src/agent-config.js";
import { AcpConnector } from "../src/acp-connector.js";
import { OpenClawConnector } from "../src/connector.js";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { renderAgentDeployment } from "../src/agent-deploy.js";
const config: any = {
  channel: { baseUrl: "https://channel.example", tokenEnv: "CHANNEL" },
  runtime: {
    type: "acp",
    agentId: "coding",
    command: process.execPath,
    args: [],
    timeoutMs: 2000,
    workspaces: { "2": "." },
    envRefs: {},
    permissionPolicy: "deny",
  },
  stateFile: "state.db",
  pollIntervalMs: 100,
  requestTimeoutMs: 1000,
};
test("factory selects ACP without a Gateway secret and rejects container rendering", () => {
  assert.ok(
    createRuntime(config.runtime, "agent.yaml") instanceof AcpConnector,
  );

  assert.throws(
    () => renderAgentDeployment(config, "agent.yaml", "unused"),
    /native/i,
  );
});
test("unknown runtime is rejected", () => {
  assert.throws(
    () => createRuntime({ type: "invalid" } as never, "agent.yaml"),
    /runtime/i,
  );
});
test("runtime type is mandatory and explicit OpenClaw and ACP configs load", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-config-"));
  t.after(() => {
    const actual = realpathSync.native(dir);
    assert.equal(dirname(actual), realpathSync.native(tmpdir()));
    assert.ok(basename(actual).startsWith("runtime-config-"));
    rmSync(actual, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "token"), "fixture");
  const path = join(dir, "agent.yaml");
  const openclaw = {
    ...config,
    channel: { baseUrl: "https://channel.example", tokenFile: "token" },
    runtime: {
      baseUrl: "http://127.0.0.1:18789",
      tokenFile: "token",
      agentId: "test",
      timeoutMs: 1000,
      maxToolRounds: 2,
    },
  };
  writeFileSync(path, JSON.stringify(openclaw));
  assert.throws(() => loadAgentConfig(path), /runtime/);
  assert.throws(
    () => createRuntime(openclaw.runtime as never, path),
    /runtime/,
  );
  (openclaw.runtime as any).type = "openclaw";
  writeFileSync(path, JSON.stringify(openclaw));
  const loadedOpenclaw = loadAgentConfig(path);
  assert.ok(
    createRuntime(
      loadedOpenclaw.config.runtime,
      path,
      loadedOpenclaw.secrets.runtime,
    ) instanceof OpenClawConnector,
  );
  const input = {
    ...config,
    channel: openclaw.channel,
    runtime: { ...config.runtime },
  };
  delete input.runtime.args;
  delete input.runtime.envRefs;
  writeFileSync(path, JSON.stringify(input));
  const { config: loaded, secrets } = loadAgentConfig(path);
  assert.equal(secrets.runtime, undefined);
  assert.equal(loaded.runtime.type, "acp");
  if (loaded.runtime.type === "acp") {
    assert.deepEqual(loaded.runtime.args, []);
    assert.deepEqual(loaded.runtime.envRefs, {});
  }
  delete input.runtime.permissionPolicy;
  writeFileSync(path, JSON.stringify(input));
  assert.throws(() => loadAgentConfig(path), /Invalid agent configuration/);
});
test("loaded credentials are a single snapshot and runtime construction does not reread files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agent.json");
  const token = join(dir, "token");
  writeFileSync(token, "gateway-secret");
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      channel: { baseUrl: "https://channel.example", tokenEnv: "CHANNEL" },
      runtime: {
        type: "openclaw",
        baseUrl: "http://localhost",
        tokenFile: "token",
        agentId: "github",
        timeoutMs: 1000,
        maxToolRounds: 2,
      },
    }),
  );
  let reads = 0;
  const loaded = loadAgentConfig(path, {
    get CHANNEL() {
      reads++;
      return "connector-secret";
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(loaded.secrets, {
    channel: "connector-secret",
    runtime: "gateway-secret",
  });
  assert.equal(JSON.stringify(loaded.config).includes("gateway-secret"), false);
  rmSync(token);
  assert.ok(
    createRuntime(
      loaded.config.runtime,
      path,
      loaded.secrets.runtime,
    ) instanceof OpenClawConnector,
  );
});
