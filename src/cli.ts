import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { renderDeployment } from "./deploy.js";
import { buildDoctorReport, runComposeLifecycle } from "./lifecycle.js";

const sample =
  'server:\n  host: 0.0.0.0\n  port: 3000\n  adminTokenFile: secrets/channel-admin-token\ndataFile: /data/channel.db\ngithub:\n  appId: "REPLACE_WITH_APP_ID"\n  privateKeyFile: secrets/github-app-private-key.pem\n  webhookSecretFile: secrets/github-webhook-secret\n  botLogin: your-app[bot]\nruntime:\n  baseUrl: http://openclaw:18789\n  tokenFile: secrets/openclaw-gateway-token\n  agentId: github\n  timeoutMs: 180000\n  maxToolRounds: 8\nbindings: []\ndeployment:\n  mode: external\n  publicUrl: https://github-agent.example.com\n';
function help() {
  console.log(
    "github-agent-channel\n  init [directory]\n  config check [path]\n  config print-public [path]\n  doctor [path] (offline configuration and Compose checks)\n  deploy render [path] [output-dir]\n  deploy up|down|status [output-dir]\n",
  );
}
function main(argv: string[]) {
  const [command, action] = argv;
  const path = resolve(argv[2] ?? "config.local.yaml");
  if (!command || command === "--help" || command === "-h") return help();
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
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
