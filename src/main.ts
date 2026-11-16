import { ConfigManager } from "./config.js";
import { TaskStore } from "./store.js";
import { OctokitGitHubClient } from "./github.js";
import { OpenClawConnector } from "./connector.js";
import { Worker } from "./worker.js";
import { createChannelServer } from "./server.js";

try {
  const manager = new ConfigManager(
    process.env.CHANNEL_CONFIG ?? "config.local.yaml",
  );
  const config = manager.snapshot().config;
  const store = new TaskStore(config.dataFile);
  store.recover();
  const github = new OctokitGitHubClient(
    config,
    process.env[config.github.privateKeyEnv]!,
  );
  const runtime = new OpenClawConnector(
    config.runtime,
    process.env[config.runtime.tokenEnv]!,
  );
  const worker = new Worker(store, github, runtime);
  const server = createChannelServer(
    config,
    store,
    process.env[config.github.webhookSecretEnv]!,
    process.env[config.server.adminTokenEnv]!,
  );
  server.listen(config.server.port, config.server.host, () =>
    console.log(
      JSON.stringify({
        event: "listening",
        host: config.server.host,
        port: config.server.port,
      }),
    ),
  );
  const timer = setInterval(() => {
    void worker
      .tick()
      .catch(() => console.error(JSON.stringify({ event: "worker_failure" })));
  }, 500);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      clearInterval(timer);
      server.close();
      // Persisted running/sending states recover as unknown after shutdown; no automatic rerun.
      setTimeout(() => process.exit(0), 1000).unref();
    });
} catch {
  console.error(
    "Channel startup failed: check configuration and required environment references",
  );
  process.exitCode = 1;
}
