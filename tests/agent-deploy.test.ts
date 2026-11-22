import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { renderAgentDeployment } from "../src/agent-deploy.js";
import type { AgentConfig } from "../src/agent-config.js";
test("agent bundle has outbound-only service, two secret mounts, and persistent journal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg: AgentConfig = {
    channel: { baseUrl: "https://channel.example.com", tokenFile: "cloud" },
    runtime: {
      baseUrl: "http://openclaw:18789",
      tokenEnv: "LOCAL_TOKEN",
      agentId: "github",
      timeoutMs: 1000,
      maxToolRounds: 3,
    },
    stateFile: "state.db",
    pollIntervalMs: 100,
    requestTimeoutMs: 1000,
    deployment: { network: "runtime-network", projectName: "my-agent" },
  };
  const files = renderAgentDeployment(
    cfg,
    join(dir, "agent.yaml"),
    join(dir, "out"),
  );
  const compose = parse(readFileSync(files.composePath, "utf8"));
  const runtime = parse(readFileSync(files.runtimeConfigPath, "utf8"));
  assert.equal(compose.services.agent.ports, undefined);
  assert.equal(Object.keys(compose.services).length, 1);
  assert.equal(Object.keys(compose.secrets).length, 2);
  assert.deepEqual(compose.secrets.runtime_token, {
    environment: "LOCAL_TOKEN",
  });
  assert.equal(compose.networks.runtime.name, "runtime-network");
  assert.equal(runtime.stateFile, "/data/agent.db");
  assert.equal(runtime.channel.tokenFile, "/run/secrets/connector_token");
  assert.deepEqual(compose.services.agent.command, [
    "node",
    "dist/cli.js",
    "agent",
    "run",
    "/app/agent.runtime.yaml",
  ]);
  assert.doesNotThrow(() =>
    renderAgentDeployment(cfg, join(dir, "agent.yaml"), join(dir, "out")),
  );
  cfg.runtime.agentId = "other";
  assert.throws(
    () => renderAgentDeployment(cfg, join(dir, "agent.yaml"), join(dir, "out")),
    /differs/,
  );
  cfg.deployment = { image: "ghcr.io/example/agent:1.2.3" };
  const imageFiles = renderAgentDeployment(
    cfg,
    join(dir, "agent.yaml"),
    join(dir, "image"),
  );
  const imageCompose = parse(readFileSync(imageFiles.composePath, "utf8"));
  assert.equal(
    imageCompose.services.agent.image,
    "ghcr.io/example/agent:1.2.3",
  );
  assert.equal(imageCompose.services.agent.build, undefined);
});
