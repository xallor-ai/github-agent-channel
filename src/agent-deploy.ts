import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";
import { projectRoot } from "./deploy.js";
import type { AgentConfig } from "./agent-config.js";

export function renderAgentDeployment(
  config: AgentConfig,
  configPath: string,
  outputDir: string,
): { composePath: string; runtimeConfigPath: string } {
  const project = config.deployment?.projectName ?? "github-channel-agent";
  const network = config.deployment?.network;
  const image = config.deployment?.image;
  if (
    image !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/.test(image) || image.length > 512)
  )
    throw Error("Invalid agent deployment image");
  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(project) ||
    (network && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network))
  )
    throw Error("Invalid agent deployment name");
  const root = dirname(resolve(configPath));
  const dir = resolve(outputDir);
  const runtime = structuredClone(config);
  delete runtime.deployment;
  runtime.stateFile = "/data/agent.db";
  const secrets: Record<string, { file: string } | { environment: string }> =
    {};
  for (const [section, name] of [
    [runtime.channel, "connector_token"],
    [runtime.runtime, "runtime_token"],
  ] as const) {
    if (Boolean(section.tokenFile) === Boolean(section.tokenEnv))
      throw Error("Exactly one agent secret reference is required");
    if (section.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(section.tokenEnv))
      throw Error("Invalid agent secret environment reference");
    secrets[name] = section.tokenFile
      ? { file: resolve(root, section.tokenFile) }
      : { environment: section.tokenEnv! };
    delete section.tokenEnv;
    section.tokenFile = "/run/secrets/" + name;
  }
  const runtimeConfigPath = resolve(dir, "agent.runtime.yaml");
  const composePath = resolve(dir, "compose.yaml");
  const compose = {
    name: project,
    services: {
      agent: {
        ...(image ? { image } : { build: { context: projectRoot } }),
        restart: "unless-stopped",
        init: true,
        command: [
          "node",
          "dist/cli.js",
          "agent",
          "run",
          "/app/agent.runtime.yaml",
        ],
        volumes: [
          {
            type: "bind",
            source: runtimeConfigPath,
            target: "/app/agent.runtime.yaml",
            read_only: true,
            bind: { create_host_path: false },
          },
          "agent-data:/data",
        ],
        secrets: Object.keys(secrets),
        networks: ["runtime"],
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
      },
    },
    secrets,
    volumes: { "agent-data": {} },
    networks: { runtime: network ? { external: true, name: network } : {} },
  };
  const files = new Map([
    [composePath, stringify(compose).replace(/\$/g, () => "$$")],
    [runtimeConfigPath, stringify(runtime)],
  ]);
  for (const [path, content] of files)
    if (existsSync(path) && readFileSync(path, "utf8") !== content)
      throw Error("Deployment output differs; choose a new output directory");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [path, content] of files)
    if (!existsSync(path))
      writeFileSync(path, content, { flag: "wx", mode: 0o644 });
  return { composePath, runtimeConfigPath };
}
