import { spawnSync } from "node:child_process";
import type { ChannelConfig } from "./contracts.js";
import { loadConfig } from "./config.js";

export type ComposeAction = "up" | "down" | "status";
export interface SpawnResult {
  status: number | null;
  error?: Error;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}
export type SpawnLike = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => SpawnResult;

const nativeSpawn: SpawnLike = (command, args, options) =>
  spawnSync(command, args, options as never) as unknown as SpawnResult;

export function composeArgs(
  action: ComposeAction,
  composePath: string,
): string[] {
  const base = ["compose", "-f", composePath];
  if (action === "up") return [...base, "up", "-d", "--build", "--wait"];
  if (action === "status") return [...base, "ps"];
  return [...base, "down"];
}

export function detectComposeVersion(spawn: SpawnLike = nativeSpawn): string {
  const result = spawn("docker", ["compose", "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Docker Compose v2 plugin is required. Install `docker compose`; legacy `docker-compose` is unsupported.",
    );
  }
  const output = String(result.stdout ?? result.stderr ?? "").trim();
  const version = output.match(/Docker Compose version v?(\d+)\.(\d+)\.(\d+)/);
  if (
    !version ||
    Number(version[1]) < 2 ||
    (Number(version[1]) === 2 && Number(version[2]) < 20)
  )
    throw new Error(
      "Docker Compose plugin 2.20 or newer is required for secrets and health waits",
    );
  return output;
}

export function runComposeLifecycle(
  action: ComposeAction,
  composePath: string,
  spawn: SpawnLike = nativeSpawn,
): number {
  detectComposeVersion(spawn);
  const result = spawn("docker", composeArgs(action, composePath), {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function buildDoctorReport(
  configPath: string,
  spawn: SpawnLike = nativeSpawn,
): Record<string, unknown> {
  const config: ChannelConfig = loadConfig(configPath);
  return {
    mode: "offline",
    config: "valid",
    secrets: "references-resolved",
    enabledBindings: config.bindings.filter((binding) => binding.enabled)
      .length,
    warnings: config.bindings.some((binding) => binding.enabled)
      ? []
      : ["No enabled repository bindings: all comments will be ignored"],
    deployment: config.deployment?.mode ?? "external",
    connector: config.connector.workerId,
    compose: { status: "available", version: detectComposeVersion(spawn) },
  };
}
