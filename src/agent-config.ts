import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

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
const ref = {
  tokenFile: z.string().min(1).optional(),
  tokenEnv: envName.optional(),
};
const schema = z.strictObject({
  channel: z.strictObject({
    baseUrl: z.string().refine((v) => origin(v, true)),
    ...ref,
  }),
  runtime: z.strictObject({
    baseUrl: z.string().refine((v) => origin(v, false)),
    ...ref,
    agentId: z.string().min(1),
    timeoutMs: z.number().int().min(1).max(3600000),
    maxToolRounds: z.number().int().min(1).max(100),
  }),
  stateFile: z.string().min(1),
  pollIntervalMs: z.number().int().min(100).max(60000),
  requestTimeoutMs: z.number().int().min(100).max(60000),
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

export function agentSecrets(
  config: AgentConfig,
  path: string,
  env: Env = process.env,
) {
  const read = (name: "channel" | "runtime") => {
    const ref = config[name];
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
  };
  return { channel: read("channel"), runtime: read("runtime") };
}
export function loadAgentConfig(
  path: string,
  env: Env = process.env,
): AgentConfig {
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
  agentSecrets(config, path, env);
  config.stateFile = resolve(dirname(resolve(path)), config.stateFile);
  return config;
}
