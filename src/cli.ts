import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cloudExample, agentExample } from "./examples.js";
import { loadAgentConfig } from "./agent-config.js";
import { runAgent } from "./agent.js";
import { renderAgentDeployment } from "./agent-deploy.js";
import { loadConfig } from "./config.js";
import { renderDeployment } from "./deploy.js";
import { buildDoctorReport, runComposeLifecycle } from "./lifecycle.js";

const sample = cloudExample;
function help() {
  console.log(
    "github-agent-channel\n  init [directory] (ECS configuration)\n  agent init [directory]\n  agent check|run [agent-config]\n  agent deploy render [agent-config] [output-dir]\n  agent deploy up|down|status [output-dir]\n  config check [path]\n  config print-public [path]\n  doctor [path] (offline configuration and Compose checks)\n  deploy render [path] [output-dir]\n  deploy up|down|status [output-dir]\n",
  );
}
async function main(argv: string[]) {
  const [command, action] = argv;
  const path = resolve(argv[2] ?? "config.local.yaml");
  if (!command || command === "--help" || command === "-h") return help();
  if (command === "agent") {
    if (action === "deploy") {
      const operation = argv[2];
      if (operation === "render") {
        const source = resolve(argv[3] ?? "agent.local.yaml");
        console.log(
          JSON.stringify(
            renderAgentDeployment(
              loadAgentConfig(source),
              source,
              argv[4] ?? ".channel-agent",
            ),
            null,
            2,
          ),
        );
        return;
      }
      if (
        operation === "up" ||
        operation === "down" ||
        operation === "status"
      ) {
        const compose = resolve(argv[3] ?? ".channel-agent", "compose.yaml");
        if (!existsSync(compose))
          throw new Error("Generate the agent deployment before starting it");
        process.exitCode = runComposeLifecycle(operation, compose);
        return;
      }
      throw new Error("Unknown agent deployment command");
    }
    const agentPath = resolve(argv[2] ?? "agent.local.yaml");
    if (action === "init") {
      const directory = resolve(argv[2] ?? ".");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "agent.local.yaml"), agentExample, {
        flag: "wx",
        mode: 0o600,
      });
      mkdirSync(join(directory, "secrets"), { recursive: true, mode: 0o700 });
      console.log(
        "Agent configuration created; fill channel URL and secret files",
      );
      return;
    }
    if (action === "check") {
      loadAgentConfig(agentPath);
      console.log("Agent configuration valid");
      return;
    }
    if (action === "run") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await runAgent(agentPath, controller.signal);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return;
    }
    throw new Error("Unknown agent command; use --help");
  }
  if (command === "init") {
    const targetDir = resolve(action ?? ".");
    const target = join(targetDir, "config.local.yaml");
    if (existsSync(target)) throw new Error(`${target} already exists`);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, sample, { flag: "wx", mode: 0o600 });
    mkdirSync(join(targetDir, "secrets"), { recursive: true });
    console.log(
      `Created ${target}; add secrets under ${join(targetDir, "secrets")}`,
    );
    return;
  }
  if (
    command === "config" &&
    (action === "check" || action === "print-public")
  ) {
    const config = loadConfig(path);
    if (action === "print-public") console.log(JSON.stringify(config, null, 2));
    else console.log(`Configuration valid: ${path}`);
    return;
  }
  if (command === "deploy" && action === "render") {
    const result = renderDeployment(
      loadConfig(path),
      path,
      argv[3] ?? ".channel",
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "doctor") {
    console.log(
      JSON.stringify(
        buildDoctorReport(resolve(action ?? "config.local.yaml")),
        null,
        2,
      ),
    );
    return;
  }
  if (
    command === "deploy" &&
    (action === "up" || action === "down" || action === "status")
  ) {
    const output = resolve(argv[2] ?? ".channel");
    const compose = resolve(output, "compose.yaml");
    if (!existsSync(compose))
      throw new Error(`Missing generated deployment: ${compose}`);
    process.exitCode = runComposeLifecycle(action, compose);
    return;
  }
  throw new Error("Unknown command; use --help");
}
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
