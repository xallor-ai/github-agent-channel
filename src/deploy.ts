import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type { ChannelConfig } from "./contracts.js";

export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const CADDY_IMAGE = "caddy:2.10.2-alpine";
export interface DeploymentFiles {
  composePath: string;
  caddyfilePath?: string;
  nginxPath: string;
  runtimeConfigPath: string;
}

export function renderDeployment(
  config: ChannelConfig,
  configPath: string,
  outputDir: string,
): DeploymentFiles {
  const deployment = config.deployment;
  const mode = deployment?.mode ?? "external";
  let origin: string | undefined;
  if (mode === "caddy") {
    if (!deployment?.publicUrl)
      throw new Error("deployment.publicUrl is required");
    const url = new URL(deployment.publicUrl);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      /[\s{}$]/.test(deployment.publicUrl)
    )
      throw new Error("Invalid deployment.publicUrl");
    origin = url.origin;
  }
  const root = dirname(resolve(configPath));
  const dir = resolve(outputDir);
  const project = deployment?.projectName ?? "github-agent-channel";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw new Error("Invalid deployment.projectName");
  const network = deployment?.network;
  if (network && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network))
    throw new Error("Invalid deployment.network");
  const localPort = deployment?.localPort ?? 18896;
  const image = deployment?.image;
  if (image && !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image))
    throw new Error("Invalid deployment.image");
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535)
    throw new Error("Invalid deployment.localPort");
  const runtime = structuredClone(config);
  delete runtime.deployment;
  runtime.server.host = "0.0.0.0";
  runtime.server.port = 3000;
  runtime.dataFile = "/data/channel.db";
  const secrets: Record<string, { file: string } | { environment: string }> =
    {};
  const references = [
    [runtime.server, "adminToken", "channel_admin_token"],
    [runtime.github, "privateKey", "github_private_key"],
    [runtime.github, "webhookSecret", "github_webhook_secret"],
  ] as const;
  for (const [section, key, secretName] of references) {
    const entry = section as unknown as Record<string, unknown>;
    const file = entry[key + "File"] as string | undefined;
    const env = entry[key + "Env"] as string | undefined;
    if (Boolean(file) === Boolean(env))
      throw new Error("Exactly one secret reference is required for " + key);
    if (env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))
      throw new Error("Invalid secret environment reference");
    secrets[secretName] = file
      ? { file: resolve(root, file) }
      : { environment: env! };
    entry[key + "File"] = "/run/secrets/" + secretName;
    delete entry[key + "Env"];
  }
  const composePath = resolve(dir, "compose.yaml");
  const runtimeConfigPath = resolve(dir, "config.runtime.yaml");
  const nginxPath = resolve(dir, "nginx-webhook.conf");
  const caddyfilePath =
    mode === "caddy" ? resolve(dir, "Caddyfile") : undefined;
  const bind = (source: string, target: string) => ({
    type: "bind",
    source,
    target,
    read_only: true,
    bind: { create_host_path: false },
  });
  const compose = {
    name: project,
    services: {
      channel: {
        ...(image ? { image } : { build: { context: projectRoot } }),
        restart: "unless-stopped",
        init: true,
        environment: { CHANNEL_CONFIG: "/app/config.runtime.yaml" },
        volumes: [
          bind(runtimeConfigPath, "/app/config.runtime.yaml"),
          "channel-data:/data",
        ],
        secrets: Object.keys(secrets),
        ports: ["127.0.0.1:" + localPort + ":3000"],
        networks: {
          channel: { aliases: [project + "-channel"] },
        },
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: "10s",
          timeout: "3s",
          retries: 5,
          start_period: "10s",
        },
      },
      ...(mode === "caddy"
        ? {
            caddy: {
              image: CADDY_IMAGE,
              restart: "unless-stopped",
              ports: ["80:80", "443:443"],
              volumes: [
                bind(caddyfilePath!, "/etc/caddy/Caddyfile"),
                "caddy-data:/data",
                "caddy-config:/config",
              ],
              networks: ["channel"],
              depends_on: { channel: { condition: "service_healthy" } },
            },
          }
        : {}),
    },
    secrets,
    volumes: {
      "channel-data": {},
      ...(mode === "caddy" ? { "caddy-data": {}, "caddy-config": {} } : {}),
    },
    networks: { channel: network ? { external: true, name: network } : {} },
  };
  const caddy = `${origin} {
  @webhook {
    method POST
    path /webhooks/github /connector/v2/*
  }
  handle @webhook {
    reverse_proxy ${project}-channel:3000
  }
  handle {
    respond 404
  }
}
`;
  const upstream = network
    ? project + "-channel:3000"
    : "127.0.0.1:" + localPort;
  const proxy = network
    ? `resolver 127.0.0.11 valid=5s ipv6=off;\n    set $channel_upstream ${upstream};\n    proxy_pass http://$channel_upstream;`
    : `proxy_pass http://${upstream};`;
  const nginx = `# Include in the existing HTTPS server block. A container gateway must join deployment.network.
location = /webhooks/github {
    if ($request_method != POST) { return 405; }
    client_max_body_size 1m;
    ${proxy}
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 15s;
}
# Pairing uses GitHub user proof; other connector routes authenticate a paired device.
location ^~ /connector/v2/ {
    if ($request_method != POST) { return 405; }
    client_max_body_size 2m;
    ${proxy}
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 15s;
}
# No Channel catch-all route: /tasks/* stays private. Existing site routes are unchanged.
`;
  const files = new Map<string, string>([
    [composePath, stringify(compose).replace(/\$/g, () => "$$")],
    [runtimeConfigPath, stringify(runtime)],
    [nginxPath, nginx],
  ]);
  if (caddyfilePath) files.set(caddyfilePath, caddy);
  // Refuse unexpected replacement; generate a new bundle for a changed configuration.
  for (const [path, content] of files) {
    if (existsSync(path) && readFileSync(path, "utf8") !== content)
      throw new Error(
        "Deployment output differs; choose a new output directory",
      );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [path, content] of files) {
    if (!existsSync(path))
      writeFileSync(path, content, { flag: "wx", mode: 0o644 });
  }
  return { composePath, runtimeConfigPath, caddyfilePath, nginxPath };
}
