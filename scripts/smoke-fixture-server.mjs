import { readFileSync } from "node:fs";
// Container-only synthetic integration harness. Never included in production image.
import { loadConfig } from "../dist/config.js";
import { resolveSecrets } from "../dist/secrets.js";
import { TaskStore } from "../dist/store.js";
import { DeliveryWorker } from "../dist/worker.js";
import { PullCoordinator } from "../dist/pull.js";
import { createChannelServer } from "../dist/server.js";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const path = process.env.CHANNEL_CONFIG;
const config = loadConfig(path);
const secrets = resolveSecrets(config, path);
const store = new TaskStore(config.dataFile);
const credential = readFileSync(
  "/run/secrets/fixture_connector",
  "utf8",
).trim();
if (!store.activeBinding(1, 2))
  store.registry.apply(
    {
      deviceId: "smoke-worker",
      administratorId: 5,
      installationId: 1,
      repositoryId: 2,
      owner: "fixture",
      repo: "fixture",
    },
    0,
    {
      enabled: true,
      responsibleAgent: {
        type: "openclaw",
        id: "github",
        deepReview: true,
        nativeReview: true,
      },
      events: ["issue_comment.created"],
    },
  );
store.recover();
// Synthetic observation tables live outside the production task database.
const db = new DatabaseSync(join(dirname(config.dataFile), "smoke.db"));
db.exec(
  "CREATE TABLE IF NOT EXISTS smoke_publications(taskId TEXT, text TEXT)",
);
db.exec("CREATE TABLE IF NOT EXISTS smoke_claims(accepted INTEGER)");
const github = {
  authorize: async (task) => {
    if (task.actorLogin !== "tester" || task.repositoryId !== 2)
      throw new Error("Synthetic scope denied");
  },
  readIssue: async () => ({ title: "synthetic issue", body: "fixture" }),
  readFile: async () => ({ content: "fixture" }),
  publishComment: async (task, text) => {
    db.prepare("INSERT INTO smoke_publications VALUES (?, ?)").run(
      task.id,
      text,
    );
    return {
      id: 7,
      url: "https://github.com/fixture/fixture/issues/3#issuecomment-7",
    };
  },
};
const coordinator = new PullCoordinator(
  store,
  github,
  config.connector,
  (token) => (token === credential ? { deviceId: "smoke-worker" } : undefined),
);
const worker = new DeliveryWorker(store, github);
const server = createChannelServer(
  config,
  store,
  secrets.webhookSecret,
  secrets.adminToken,
  coordinator,
);
server.on("request", (req, res) => {
  if (req.url === "/connector/v2/claim")
    res.once("finish", () => {
      if (
        req.headers.authorization === "Bearer " + credential &&
        [200, 204].includes(res.statusCode)
      )
        db.prepare("INSERT INTO smoke_claims VALUES (1)").run();
    });
});
server.listen(config.server.port, config.server.host);
const timer = setInterval(() => {
  coordinator.expire();
  void worker.tick();
}, 50);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => {
      db.close();
      store.close();
      process.exit(0);
    });
  });
