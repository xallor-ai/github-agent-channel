import { loadConfig } from "./config.js";
import { TaskStore } from "./store.js";
import { OctokitGitHubClient } from "./github.js";
import { PullCoordinator } from "./pull.js";
import { DeliveryWorker } from "./worker.js";
import { createChannelServer } from "./server.js";
import { resolveSecrets } from "./secrets.js";
import { StorageSchemaError } from "./store-schema.js";

try {
  const configPath = process.env.CHANNEL_CONFIG ?? "config.local.yaml";
  const config = loadConfig(configPath);
  const secrets = resolveSecrets(config, configPath);
  const store = new TaskStore(config.dataFile);
  store.recover();
  const github = new OctokitGitHubClient(config, secrets.privateKey);
  const coordinator = new PullCoordinator(
    store,
    github,
    config.connector,
    secrets.connectorToken,
  );
  const worker = new DeliveryWorker(store, github);
  const server = createChannelServer(
    config,
    store,
    secrets.webhookSecret,
    secrets.adminToken,
    coordinator,
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
    coordinator.expire();
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
} catch (error) {
  console.error(
    error instanceof StorageSchemaError
      ? error.message
      : "Channel startup failed: check configuration and required environment references",
  );
  process.exitCode = 1;
}
