import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ChannelConfig } from "../src/contracts.js";
import { projectRoot, renderDeployment } from "../src/deploy.js";

const secretValues = {
  admin: "admin-file-secret-should-not-escape",
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nprivate-file-secret\n-----END PRIVATE KEY-----\n",
  webhook: "webhook-file-secret",
  runtime: "runtime-file-secret",
};

function baseConfig(deployment?: ChannelConfig["deployment"]): ChannelConfig {
  return {
    server: { host: "127.0.0.1", port: 8765, adminTokenFile: "secrets/admin" },
    dataFile: "./var/channel.db",
    github: {
      appId: "123",
      privateKeyFile: "secrets/private.pem",
      webhookSecretFile: "secrets/webhook",
      botLogin: "test[bot]",
    },
    runtime: {
      baseUrl: "http://openclaw:18789",
      tokenFile: "secrets/runtime",
      agentId: "github",
      timeoutMs: 1000,
      maxToolRounds: 8,
    },
    bindings: [],
    ...(deployment ? { deployment } : {}),
  };
}
function environmentConfig(): ChannelConfig {
  return {
    server: { host: "127.0.0.1", port: 8765, adminTokenEnv: "CHANNEL_ADMIN" },
    dataFile: "./var/channel.db",
    github: {
      appId: "123",
      privateKeyEnv: "GITHUB_PRIVATE_KEY",
      webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
      botLogin: "test[bot]",
    },
    runtime: {
      baseUrl: "http://openclaw:18789",
      tokenEnv: "OPENCLAW_TOKEN",
      agentId: "github",
      timeoutMs: 1000,
      maxToolRounds: 8,
    },
    bindings: [],
    deployment: { mode: "external", localPort: 19999 },
  };
}
function fixture(t: test.TestContext, config: ChannelConfig) {
  const root = mkdtempSync(join(tmpdir(), "channel-deploy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets/admin"), secretValues.admin);
  writeFileSync(join(root, "secrets/private.pem"), secretValues.privateKey);
  writeFileSync(join(root, "secrets/webhook"), secretValues.webhook);
  writeFileSync(join(root, "secrets/runtime"), secretValues.runtime);
  const configPath = join(root, "config.local.yaml");
  writeFileSync(configPath, "# test fixture\n");
  return { root, configPath, output: join(root, ".channel"), config };
}
function generatedText(files: ReturnType<typeof renderDeployment>) {
  return [
    readFileSync(files.composePath, "utf8"),
    readFileSync(files.runtimeConfigPath, "utf8"),
    readFileSync(files.nginxPath, "utf8"),
    files.caddyfilePath ? readFileSync(files.caddyfilePath, "utf8") : "",
  ].join("\n");
}

test("caddy mode normalizes the runtime and emits a canonical HTTPS edge", (t) => {
  const { config, configPath, output } = fixture(
    t,
    baseConfig({
      mode: "caddy",
      publicUrl: "https://channel.example.com/",
      network: "existing_gateway",
      projectName: "github-channel",
      localPort: 18897,
    }),
  );
  const files = renderDeployment(config, configPath, output);
  const compose = parse(readFileSync(files.composePath, "utf8"));
  const runtime = parse(readFileSync(files.runtimeConfigPath, "utf8"));
  const caddy = readFileSync(files.caddyfilePath!, "utf8");
  const nginx = readFileSync(files.nginxPath, "utf8");
  assert.equal(compose.name, "github-channel");
  assert.equal(compose.services.channel.build.context, projectRoot);
  assert.equal(compose.services.channel.ports[0], "127.0.0.1:18897:3000");
  assert.equal(compose.networks.channel.external, true);
  assert.equal(compose.networks.channel.name, "existing_gateway");
  assert.equal(runtime.server.host, "0.0.0.0");
  assert.equal(runtime.server.port, 3000);
  assert.equal(runtime.dataFile, "/data/channel.db");
  assert.equal(
    runtime.github.privateKeyFile,
    "/run/secrets/github_private_key",
  );
  assert.equal(runtime.github.privateKeyEnv, undefined);
  assert.equal(runtime.runtime.tokenFile, "/run/secrets/runtime_token");
  assert.match(caddy, /^https:\/\/channel\.example\.com \{/);
  assert.match(caddy, /path \/webhooks\/github/);
  assert.match(caddy, /reverse_proxy github-channel-channel:3000/);
  assert.match(caddy, /respond 404/);
  assert.doesNotMatch(caddy, /tasks/);
  assert.match(nginx, /location = \/webhooks\/github/);
  assert.match(nginx, /set \$channel_upstream github-channel-channel:3000/);
  assert.match(nginx, /resolver 127\.0\.0\.11 valid=5s/);
  assert.match(nginx, /proxy_pass http:\/\/\$channel_upstream/);
  assert.match(nginx, /request_method != POST/);
  assert.doesNotMatch(nginx, /location \/tasks/);
  assert.doesNotMatch(
    generatedText(files),
    /admin-file-secret|private-file-secret|webhook-file-secret|runtime-file-secret/,
  );
});

test("external mode maps environment secrets without serializing their values", (t) => {
  const { root, configPath, output } = fixture(t, environmentConfig());
  const files = renderDeployment(environmentConfig(), configPath, output);
  const compose = parse(readFileSync(files.composePath, "utf8"));
  const runtime = parse(readFileSync(files.runtimeConfigPath, "utf8"));
  const nginx = readFileSync(files.nginxPath, "utf8");
  assert.equal(compose.services.channel.ports[0], "127.0.0.1:19999:3000");
  assert.deepEqual(compose.secrets, {
    channel_admin_token: { environment: "CHANNEL_ADMIN" },
    github_private_key: { environment: "GITHUB_PRIVATE_KEY" },
    github_webhook_secret: { environment: "GITHUB_WEBHOOK_SECRET" },
    runtime_token: { environment: "OPENCLAW_TOKEN" },
  });
  assert.equal(runtime.server.host, "0.0.0.0");
  assert.equal(runtime.server.port, 3000);
  assert.equal(
    runtime.server.adminTokenFile,
    "/run/secrets/channel_admin_token",
  );
  assert.equal(
    runtime.github.privateKeyFile,
    "/run/secrets/github_private_key",
  );
  assert.equal(runtime.runtime.tokenFile, "/run/secrets/runtime_token");
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:19999/);
  assert.equal(files.caddyfilePath, undefined);
  assert.doesNotMatch(
    generatedText(files),
    /admin-file-secret|private-file-secret|webhook-file-secret|runtime-file-secret/,
  );
  assert.equal(compose.services.caddy, undefined);
  assert.deepEqual(compose.services.channel.environment, {
    CHANNEL_CONFIG: "/app/config.runtime.yaml",
  });
});

test("rejects URL injection and keeps generated bundles immutable", (t) => {
  const data = fixture(
    t,
    baseConfig({ mode: "caddy", publicUrl: "https://channel.example.com" }),
  );
  assert.throws(
    () =>
      renderDeployment(
        baseConfig({
          mode: "caddy",
          publicUrl: "https://channel.example.com/${SITE}",
        }),
        data.configPath,
        data.output,
      ),
    /Invalid deployment\.publicUrl/,
  );
  const files = renderDeployment(data.config, data.configPath, data.output);
  assert.doesNotThrow(() =>
    renderDeployment(data.config, data.configPath, data.output),
  );
  assert.throws(
    () =>
      renderDeployment(
        baseConfig({
          mode: "caddy",
          publicUrl: "https://channel.example.com",
          localPort: 19998,
        }),
        data.configPath,
        data.output,
      ),
    /choose a new output directory/,
  );
  assert.ok(files.composePath.endsWith("compose.yaml"));
});

test("escapes literal dollar signs in Compose paths and keeps source context independent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "channel-$-deploy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secretDir = join(root, "secret$dir");
  mkdirSync(secretDir, { recursive: true });
  for (const [name, value] of Object.entries(secretValues))
    writeFileSync(join(secretDir, name), value);
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, "# external config outside source\n");
  const config = baseConfig();
  config.server.adminTokenFile = "secret$dir/admin";
  config.github.privateKeyFile = "secret$dir/private.pem";
  config.github.webhookSecretFile = "secret$dir/webhook";
  config.runtime.tokenFile = "secret$dir/runtime";
  const files = renderDeployment(config, configPath, join(root, "out"));
  const composeText = readFileSync(files.composePath, "utf8");
  const compose = parse(composeText);
  assert.equal(compose.services.channel.build.context, projectRoot);
  assert.ok(composeText.includes("secret$$dir"));
  assert.doesNotMatch(composeText, /secret-content/);
});
