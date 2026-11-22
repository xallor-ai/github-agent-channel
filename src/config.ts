import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ChannelConfig } from "./contracts.js";
import { resolveSecrets, SecretReferenceError } from "./secrets.js";

const name = z.string().trim().min(1);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const publicUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      /^[a-z0-9.-]+$/i.test(url.hostname) &&
      !/[\s{}$]/.test(value) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}, "deployment.publicUrl must be an HTTPS origin");
const schema = z.strictObject({
  server: z.strictObject({
    host: name,
    port: z.number().int().min(1).max(65535),
    adminTokenEnv: envName.optional(),
    adminTokenFile: name.optional(),
  }),
  dataFile: name,
  github: z.strictObject({
    appId: z.string().regex(/^[1-9][0-9]*$/),
    privateKeyEnv: envName.optional(),
    privateKeyFile: name.optional(),
    webhookSecretEnv: envName.optional(),
    webhookSecretFile: name.optional(),
    botLogin: name,
  }),
  runtime: z.strictObject({
    baseUrl: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
    tokenEnv: envName.optional(),
    tokenFile: name.optional(),
    agentId: name,
    timeoutMs: z.number().int().min(1).max(3_600_000),
    maxToolRounds: z.number().int().min(1).max(100),
  }),
  bindings: z.array(
    z.strictObject({
      id: name,
      installationId: positiveId,
      repositoryId: positiveId,
      owner: name,
      repo: name,
      enabled: z.boolean(),
    }),
  ),
  deployment: z
    .strictObject({
      mode: z.enum(["external", "caddy"]),
      publicUrl: publicUrl.optional(),
      network: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
        .optional(),
      projectName: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]*$/)
        .optional(),
      localPort: z.number().int().min(1024).max(65535).optional(),
    })
    .optional()
    .superRefine((value, ctx) => {
      if (value?.mode === "caddy" && !value.publicUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["publicUrl"],
          message: "caddy deployment requires publicUrl",
        });
      }
    }),
});
type Environment = Record<string, string | undefined>;
function validate(
  input: unknown,
  env: Environment,
  configPath = "config.yaml",
): ChannelConfig {
  const parsed = schema.safeParse(input);
  // Never include input values in errors: invalid input can contain secrets.
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "configuration";
    throw new Error(`Invalid channel configuration at ${path}`);
  }
  const config = parsed.data;
  const ids = new Set<string>();
  const scopes = new Set<string>();
  for (const binding of config.bindings) {
    const scope = `${binding.installationId}:${binding.repositoryId}`;
    if (ids.has(binding.id) || scopes.has(scope))
      throw new Error("Duplicate binding ID or repository scope");
    ids.add(binding.id);
    scopes.add(scope);
  }
  try {
    resolveSecrets(config, configPath, env);
  } catch (error) {
    if (error instanceof SecretReferenceError) throw error;
    throw new Error("Invalid channel secret references");
  }
  return config;
}
export function loadConfig(
  path: string,
  env: Environment = process.env,
): ChannelConfig {
  let input: unknown;
  try {
    const text = readFileSync(path, "utf8");
    input = /\.json$/i.test(path) ? JSON.parse(text) : parse(text);
  } catch {
    throw new Error("Unable to read or parse channel configuration");
  }
  return validate(input, env, path);
}
export function getPublicConfig(config: ChannelConfig): ChannelConfig {
  return structuredClone(config);
}
export class ConfigManager {
  private config: ChannelConfig;
  private revision = 1;
  constructor(
    private readonly path: string,
    private readonly env: Environment = process.env,
  ) {
    this.config = loadConfig(path, env);
  }
  snapshot(): { revision: number; config: ChannelConfig } {
    return { revision: this.revision, config: getPublicConfig(this.config) };
  }
  update(
    next: unknown,
    expectedRevision: number,
  ): { revision: number; config: ChannelConfig } {
    if (expectedRevision !== this.revision)
      throw new Error("Configuration revision conflict");
    const validated = validate(next, this.env, this.path);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        /\.json$/i.test(this.path)
          ? JSON.stringify(validated, null, 2) + "\n"
          : stringify(validated),
        { flag: "wx", mode: 0o600 },
      );
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
    this.config = validated;
    this.revision++;
    return this.snapshot();
  }
}
