import { DeviceService } from "./device-service.js";
import {
  AdministratorLost,
  BindingPrincipalVerifier,
} from "./binding-principal.js";
import { AccessDenied } from "./contracts.js";
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
  const devices = new DeviceService({
    dbPath: config.dataFile + ".devices",
    adminToken: secrets.adminToken,
    registry: store.registry,
    runtimeLastSeen: store.runtimeLastSeen.bind(store),
    recentActivities: store.activitiesForDevice.bind(store),
    hasWriteProfile: (i, r) =>
      !!config.writeProfiles?.some(
        (p) => p.installationId === i && p.repositoryId === r,
      ),
    appId: config.github.appId,
    privateKey: secrets.privateKey,
  });
  const verifier = new BindingPrincipalVerifier(
    config.github.appId,
    secrets.privateKey,
    async (token) => devices.authenticate(token),
  );
  const lookup = (installationId: number, repositoryId: number) => {
    const b = store.activeBinding(installationId, repositoryId);
    if (!b || !devices.isActive(b.deviceId)) return undefined;
    const policy = config.writeProfiles?.find(
      (p) =>
        p.installationId === installationId && p.repositoryId === repositoryId,
    )?.policy;
    return { ...b, writePolicy: policy };
  };
  const github = new OctokitGitHubClient(
    config,
    secrets.privateKey,
    lookup,
    async (task) => {
      const b = lookup(task.installationId, task.repositoryId);
      const device = b && devices.principalForDevice(b.deviceId);
      if (
        !b ||
        b.id !== task.bindingId ||
        !device ||
        device.githubUserId !== b.administratorId
      )
        throw new AccessDenied("Binding is no longer active");
      try {
        const { who: verified } = await verifier.verifyPaired(device, {
          owner: task.owner,
          repo: task.repo,
        });
        if (
          verified.installationId !== task.installationId ||
          verified.repositoryId !== task.repositoryId
        )
          throw new AccessDenied("Binding scope changed");
      } catch (error) {
        // Explicitly denied proof for this revision fences the binding. Transport
        // failures fail the check but do not record a guessed permanent revocation.
        if (
          error instanceof AdministratorLost &&
          error.installationId === b.installationId &&
          error.repositoryId === b.repositoryId
        )
          store.registry.disableIfCurrent(b);
        throw error;
      }
    },
    fetch,
    (id) => store.publicationAllowed(id),
  );
  const coordinator = new PullCoordinator(
    store,
    github,
    config.connector,
    (credential) => devices.authenticate(credential),
  );
  const worker = new DeliveryWorker(store, github);
  const server = createChannelServer(
    config,
    store,
    secrets.webhookSecret,
    secrets.adminToken,
    {
      async handle(req, res) {
        return (
          (await devices.handle(req, res)) ||
          (await coordinator.handle(req, res))
        );
      },
    },
    lookup,
    github.reconcileReview.bind(github),
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
