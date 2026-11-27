import { randomBytes } from "node:crypto";
import { openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  channelOrigin,
  loadChannelClient,
  readAgentSettings,
} from "./agent-config.js";
import {
  bindingDeclarationSchema,
  bindingRecordSchema as record,
} from "./binding-registry.js";

const repo = z.strictObject({
  owner: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine((v) => v !== "." && v !== ".."),
});
const id = z.number().int().positive();
const device = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const desiredFile = repo.extend({
  expectedRevision: z.number().int().nonnegative(),
  declaration: bindingDeclarationSchema,
});
type Connection = { baseUrl: string; timeout: number; token: string };

const reasons: Record<number, string> = {
  400: "Invalid request",
  401: "Credential rejected",
  403: "Authorization denied",
  404: "Resource not found",
  409: "Conflict: read current status before making another change",
  502: "GitHub verification unavailable",
};
const errorCode = z.enum([
  "invalid_request",
  "device_unauthorized",
  "admin_unauthorized",
  "invite_invalid",
  "github_identity",
  "installation_scope",
  "administrator_permission",
  "binding_owner",
  "binding_conflict",
  "github_unavailable",
  "device_not_found",
  "service_error",
]);
async function post<T>(
  connection: Connection,
  path: string,
  data: unknown,
  schema: z.ZodType<T>,
  fetcher: typeof fetch,
) {
  let response: Response;
  try {
    response = await fetcher(new URL(path, connection.baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(connection.timeout),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + connection.token,
      },
      body: JSON.stringify(data),
    });
  } catch {
    throw Error("Channel response unavailable; server state is unconfirmed");
  }
  if (!response.ok) {
    const parsed = z
      .object({ error: errorCode })
      .safeParse(await response.json().catch(() => null));
    throw Error(
      "HTTP " +
        response.status +
        ": " +
        (reasons[response.status] ?? "Channel request failed") +
        (parsed.success ? " (" + parsed.data.error + ")" : ""),
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw Error("Invalid Channel response; server state is unconfirmed");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw Error("Invalid Channel response; server state is unconfirmed");
  return parsed.data;
}

export async function repoCommand(
  action: "apply" | "status",
  file: string,
  configPath: string,
  fetcher: typeof fetch = fetch,
) {
  let settings: z.infer<typeof desiredFile>;
  try {
    settings = desiredFile.parse(parse(readFileSync(file, "utf8")));
  } catch {
    throw Error(
      "Invalid or unreadable repository declaration; no request sent",
    );
  }
  const { owner, repo, expectedRevision, declaration: desired } = settings;
  try {
    const client = loadChannelClient(configPath);
    const { binding } =
      action === "apply"
        ? await post(
            client,
            "/connector/v2/bindings/apply",
            settings,
            z.object({ binding: record }),
            fetcher,
          )
        : await post(
            client,
            "/connector/v2/bindings/read",
            { owner, repo },
            z.object({ binding: record.nullable() }),
            fetcher,
          );
    if (
      binding &&
      (binding.owner.toLowerCase() !== owner.toLowerCase() ||
        binding.repo.toLowerCase() !== repo.toLowerCase())
    )
      throw Error("Response identifies a different repository");
    const matches =
      binding &&
      binding.enabled === desired.enabled &&
      binding.requireMention === desired.requireMention &&
      !!binding.nativeReview === !!desired.nativeReview &&
      !!binding.deepReview === !!desired.deepReview &&
      binding.triggerLabel === desired.triggerLabel &&
      JSON.stringify([...binding.events].sort()) ===
        JSON.stringify(desired.events);
    const state = desired.enabled
      ? matches
        ? "active"
        : "local_pending"
      : binding?.enabled === false
        ? "disabled"
        : "disable_pending";
    return {
      repository: owner + "/" + repo,
      expectedRevision,
      desired,
      state,
      binding,
    };
  } catch (error) {
    throw Error(
      (desired.enabled ? "local_pending" : "disable_pending") +
        " (unconfirmed): " +
        (error instanceof Error ? error.message : "Request failed"),
    );
  }
}

function secretFile(path: string) {
  try {
    const s = readFileSync(path, "utf8").trim();
    if (s) return s;
  } catch {}
  throw Error("Secret file is empty or unreadable");
}

export async function pairCommand(
  inviteFile: string,
  configPath: string,
  githubToken: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const invite = secretFile(inviteFile);
  if (!githubToken?.trim())
    throw Error(
      "Set CHANNEL_PAIR_GITHUB_TOKEN or pipe a GitHub user token to stdin",
    );
  const config = readAgentSettings(configPath);
  if (
    config.channel.tokenFile !== undefined &&
    config.channel.tokenEnv === undefined
  ) {
    // Persist before POST: a lost response must not strand a newly paired device without its credential.
    const path = resolve(dirname(configPath), config.channel.tokenFile);
    try {
      writeFileSync(path, randomBytes(32).toString("base64url"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw Error("Cannot create device token file");
    }
  }
  const client = loadChannelClient(configPath, config);
  if (!/^[A-Za-z0-9_-]{43}$/.test(client.token))
    throw Error(
      "Device token must be 32 random bytes encoded as base64url; existing secret was kept",
    );
  return post(
    { ...client, token: githubToken.trim() },
    "/connector/v2/devices/pair",
    { invite, deviceToken: client.token },
    z.object({ deviceId: device, githubUserId: id }),
    fetcher,
  );
}

export async function adminCommand(
  args: string[],
  token: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const [action, url, subject, out] = args;
  if (!token?.trim())
    throw Error("Set CHANNEL_ADMIN_TOKEN on the administrator machine");
  if (!channelOrigin.safeParse(url).success)
    throw Error("Channel requires an HTTPS origin (or loopback HTTP)");
  const client = { baseUrl: url, timeout: 30_000, token: token.trim() };
  if (action === "invite" && args.length === 4) {
    const user = Number(subject);
    if (!/^[1-9][0-9]*$/.test(subject) || !id.safeParse(user).success)
      throw Error("Expected a numeric GitHub user ID");
    const fd = openSync(out, "wx", 0o600);
    try {
      const { invite, expiresAt } = await post(
        client,
        "/admin/device-invites",
        { githubUserId: user },
        z.object({ invite: z.string().min(1), expiresAt: id }),
        fetcher,
      );
      writeFileSync(fd, invite);
      return { githubUserId: user, expiresAt, inviteFile: out };
    } finally {
      closeSync(fd);
    }
  }
  if (
    action === "revoke" &&
    args.length === 3 &&
    device.safeParse(subject).success
  ) {
    return post(
      client,
      "/admin/device-revoke",
      { deviceId: subject },
      z.object({ revoked: z.literal(true) }),
      fetcher,
    );
  }
  throw Error("Invalid admin command; use --help");
}
