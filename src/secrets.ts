import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChannelConfig, ResolvedSecrets } from "./contracts.js";

type Environment = Record<string, string | undefined>;

export class SecretReferenceError extends Error {}

function readReference(
  label: string,
  envName: string | undefined,
  fileName: string | undefined,
  configPath: string,
  env: Environment,
): string {
  if ((envName === undefined) === (fileName === undefined)) {
    throw new SecretReferenceError(
      `${label} must specify exactly one Env or File reference`,
    );
  }
  let value: string | undefined;
  if (envName !== undefined) value = env[envName];
  else {
    const path = resolve(dirname(resolve(configPath)), fileName!);
    try {
      value = readFileSync(path, "utf8");
    } catch {
      throw new SecretReferenceError(
        `${label} secret file is missing or unreadable`,
      );
    }
  }
  if (!value?.trim())
    throw new SecretReferenceError(`${label} secret is empty`);
  return value;
}

export function resolveSecrets(
  config: ChannelConfig,
  configPath: string,
  env: Environment = process.env,
): ResolvedSecrets {
  return {
    adminToken: readReference(
      "server.adminToken",
      config.server.adminTokenEnv,
      config.server.adminTokenFile,
      configPath,
      env,
    ).trim(),
    privateKey: readReference(
      "github.privateKey",
      config.github.privateKeyEnv,
      config.github.privateKeyFile,
      configPath,
      env,
    ),
    webhookSecret: readReference(
      "github.webhookSecret",
      config.github.webhookSecretEnv,
      config.github.webhookSecretFile,
      configPath,
      env,
    ).trim(),
    connectorToken: readReference(
      "connector.token",
      config.connector.tokenEnv,
      config.connector.tokenFile,
      configPath,
      env,
    ).trim(),
  };
}
