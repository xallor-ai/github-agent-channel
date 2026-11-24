import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentConfig } from "../src/agent-config.js";

test("agent config accepts file refs relative to config and rejects public HTTP and GitHub keys", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agent.yaml");
  writeFileSync(join(dir, "token"), "secret-value\n");
  const cfg: any = {
    channel: { baseUrl: "https://channel.example.com", tokenFile: "token" },
    runtime: {
      type: "openclaw",
      baseUrl: "http://127.0.0.1:18789",
      tokenFile: "token",
      agentId: "github",
      timeoutMs: 1000,
      maxToolRounds: 3,
    },
    stateFile: "state.db",
    pollIntervalMs: 100,
    requestTimeoutMs: 1000,
  };
  const save = () => writeFileSync(path, JSON.stringify(cfg));
  save();
  const { config: parsed, secrets } = loadAgentConfig(path, {});
  assert.equal(parsed.stateFile, join(dir, "state.db"));
  assert.equal(secrets.channel, "secret-value");
  cfg.deployment = { image: "ghcr.io/example/agent:1.2.3" };
  save();
  assert.equal(
    loadAgentConfig(path).config.deployment?.image,
    "ghcr.io/example/agent:1.2.3",
  );
  for (const image of [
    "",
    "bad image",
    "repo:${TOKEN}",
    "repo\nname",
    "--privileged",
  ]) {
    cfg.deployment.image = image;
    save();
    assert.throws(() => loadAgentConfig(path), /deployment.image/);
  }
  delete cfg.deployment;
  cfg.channel.baseUrl = "http://public.example.com";
  save();
  assert.throws(() => loadAgentConfig(path), /channel.baseUrl/);
  cfg.channel.baseUrl = "http://127.0.0.1:1234";
  save();
  assert.doesNotThrow(() => loadAgentConfig(path));
  cfg.github = { privateKey: "private-content" };
  save();
  assert.throws(
    () => loadAgentConfig(path),
    (e) => !String(e).includes("private-content"),
  );
  delete cfg.github;
  cfg.channel.tokenEnv = "TOKEN";
  save();
  assert.throws(() => loadAgentConfig(path, { TOKEN: "x" }), /exactly one/);
});
