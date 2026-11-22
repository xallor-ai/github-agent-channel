// Container-only synthetic integration harness. Never included in production image.
import { loadConfig } from "../dist/config.js";
import { resolveSecrets } from "../dist/secrets.js";
import { TaskStore } from "../dist/store.js";
import { Worker } from "../dist/worker.js";
import { createChannelServer } from "../dist/server.js";
import { DatabaseSync } from "node:sqlite";
const path = process.env.CHANNEL_CONFIG;
const config = loadConfig(path);
const secrets = resolveSecrets(config, path);
config.bindings = [
  {
    id: "synthetic",
    installationId: 1,
    repositoryId: 2,
    owner: "fixture",
    repo: "fixture",
    enabled: true,
  },
];
const store = new TaskStore(config.dataFile);
store.recover();
const db = new DatabaseSync(config.dataFile);
db.exec(
  "CREATE TABLE IF NOT EXISTS smoke_publications(taskId TEXT, text TEXT)",
);
const github = {
  authorize: async (task) => {
    if (task.actorLogin !== "tester" || task.repositoryId !== 2)
      throw new Error("Synthetic scope denied");
  },
  readIssue: async () => ({ title: "synthetic issue", body: "fixture" }),
  readFile: async () => ({ content: "fixture" }),
  publish: async (task, text) => {
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
const runtime = {
  run: async (task, invoke) => {
    const issue = await invoke("read_issue", {});
    if (issue.title !== "synthetic issue") throw new Error("read failed");
    return { text: "synthetic reply" };
  },
};
const worker = new Worker(store, github, runtime);
const server = createChannelServer(
  config,
  store,
  secrets.webhookSecret,
  secrets.adminToken,
);
server.listen(config.server.port, config.server.host);
const timer = setInterval(() => void worker.tick(), 50);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => {
      db.close();
      store.close();
      process.exit(0);
    });
  });
