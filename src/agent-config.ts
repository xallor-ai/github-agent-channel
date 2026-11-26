import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { agentName } from "./runtime-profile.js";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const origin = (value: string, channel: boolean) => {
  try {
    const u = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/" &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" && (!channel || loopback)))
    );
  } catch {
    return false;
  }
};
export const channelOrigin = z.string().refine((v) => origin(v, true));
const ref = {
  tokenFile: z.string().min(1).optional(),
  tokenEnv: envName.optional(),
};
const commandSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(3600000),
});
const acpSchema = z.strictObject({
  type: z.literal("acp"),
  agentId: agentName,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(3600000),
  workspaces: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1)),
  envRefs: z.record(envName, envName).default({}),
  permissionPolicy: z.enum(["deny", "allow-once"]),
  verification: commandSchema.optional(),
  publication: z
    .strictObject({
      kind: z.literal("pull_request"),
      baseBranch: z.string().min(1),
    })
    .optional(),
});
export type AcpRuntimeConfig = z.infer<typeof acpSchema>;
const openclawSchema = z.strictObject({
  type: z.literal("openclaw"),
  baseUrl: z.string().refine((v) => origin(v, false)),
  ...ref,
  agentId: agentName,
  timeoutMs: z.number().int().min(1).max(3600000),
  maxToolRounds: z.number().int().min(1).max(100),
});
export type OpenClawRuntimeConfig = z.infer<typeof openclawSchema>;
const schema = z.strictObject({
  channel: z.strictObject({
    baseUrl: channelOrigin,
    ...ref,
  }),
  runtime: z.union([openclawSchema, acpSchema]),
  stateFile: z.string().min(1),
  pollIntervalMs: z.number().int().min(100).max(60000),
  requestTimeoutMs: z.number().int().min(100).max(150000),
  deployment: z
    .strictObject({
      image: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/)
        .max(512)
        .optional(),
      network: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
        .optional(),
      projectName: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]*$/)
        .optional(),
    })
    .optional(),
});
export type AgentConfig = z.infer<typeof schema>;
type Env = Record<string, string | undefined>;

function readAgentToken(
  name: string,
  ref: { tokenFile?: string; tokenEnv?: string },
  path: string,
  env: Env,
) {
  if ((ref.tokenFile === undefined) === (ref.tokenEnv === undefined))
    throw Error(name + ".token requires exactly one File or Env reference");
  let token: string | undefined;
  try {
    token = ref.tokenFile
      ? readFileSync(resolve(dirname(resolve(path)), ref.tokenFile), "utf8")
      : env[ref.tokenEnv!];
  } catch {
    throw Error(name + ".token file is unreadable");
  }
  if (!token?.trim()) throw Error(name + ".token is empty");
  return token.trim();
}
function agentSecrets(
  config: AgentConfig,
  path: string,
  env: Env = process.env,
) {
  return {
    channel: readAgentToken("channel", config.channel, path, env),
    runtime:
      config.runtime.type === "openclaw"
        ? readAgentToken("runtime", config.runtime, path, env)
        : undefined,
  };
}
export function readAgentSettings(path: string) {
  let input: unknown;
  try {
    input = parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("Cannot read agent configuration");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw Error(
      "Invalid agent configuration at " +
        (parsed.error.issues[0].path.join(".") || "configuration"),
    );
  const config = parsed.data;

  config.stateFile = resolve(dirname(resolve(path)), config.stateFile);
  return config;
}
export function loadChannelClient(
  path: string,
  config = readAgentSettings(path),
  env: Env = process.env,
) {
  return {
    baseUrl: config.channel.baseUrl,
    timeout: config.requestTimeoutMs,
    token: readAgentToken("channel", config.channel, path, env),
  };
}
export function loadAgentConfig(path: string, env: Env = process.env) {
  const config = readAgentSettings(path);
  return { config, secrets: agentSecrets(config, path, env) };
}
