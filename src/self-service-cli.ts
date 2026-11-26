import { randomBytes } from "node:crypto";
import {
  openSync,
  closeSync,
  readSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  channelOrigin,
  loadChannelClient,
  readAgentSettings,
} from "./agent-config.js";
import {
  desiredPolicySchema,
  bindingDeclarationSchema,
  effectiveEvents,
  sameDeclaration,
  bindingRecordSchema as record,
} from "./binding-registry.js";

import { activityPageSchema, paginationSchema } from "./activity-feed.js";
import { activityInboxStatus, rememberActivityBinding } from "./agent-inbox.js";
import { bindingEvent } from "./binding-events.js";
import { coverageSchema, eventCoverage } from "./binding-coverage.js";
import { runtimeProfile } from "./runtime-profile.js";

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
  declaration: desiredPolicySchema.default({ enabled: true }),
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
class BindingConflict extends Error {}
class ConfirmedConflict extends Error {}
class LocalInboxFailure extends Error {}
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
    if (
      response.status === 409 &&
      parsed.success &&
      parsed.data.error === "binding_conflict"
    )
      throw new BindingConflict("Binding revision conflict");
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

function readDesired(file: string) {
  try {
    if (file === "-" && process.stdin.isTTY)
      throw Error("Pipe a declaration to stdin");
    const fd = file === "-" ? 0 : openSync(file, "r");
    try {
      const data = Buffer.alloc(8193);
      let size = 0;
      while (size < data.length) {
        const n = readSync(fd, data, size, data.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size === data.length) throw Error("Declaration exceeds 8 KiB");
      return desiredFile.parse(
        parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            data.subarray(0, size),
          ),
        ),
      );
    } finally {
      if (file !== "-") closeSync(fd);
    }
  } catch {
    throw Error(
      "Invalid or unreadable repository declaration; no request sent",
    );
  }
}

export async function activitiesCommand(
  file: string,
  configPath: string,
  after = 0,
  limit = 25,
  fetcher: typeof fetch = fetch,
) {
  const { owner, repo } = readDesired(file);
  const config = readAgentSettings(configPath);
  const page = paginationSchema.parse({ after, limit });
  const receipt = await post(
    loadChannelClient(configPath, config),
    "/connector/v2/activities",
    { owner, repo, runtime: runtimeProfile(config.runtime), ...page },
    activityPageSchema,
    fetcher,
  );
  if (
    receipt.activities.some(
      (a) =>
        a.owner.toLowerCase() !== owner.toLowerCase() ||
        a.repo.toLowerCase() !== repo.toLowerCase(),
    ) ||
    receipt.activities.length > limit ||
    (receipt.hasMore && receipt.activities.length !== limit) ||
    (!receipt.truncated &&
      receipt.nextCursor !== (receipt.activities.at(-1)?.cursor ?? after)) ||
    receipt.nextCursor < after ||
    receipt.activities.some(
      (a, i) =>
        a.cursor <= (receipt.activities[i - 1]?.cursor ?? after) ||
        a.cursor > receipt.nextCursor,
    )
  )
    throw Error("Invalid activity receipt for this repository or cursor");
  return receipt;
}
export async function repoCommand(
  action: "apply" | "status",
  file: string,
  configPath: string,
  fetcher: typeof fetch = fetch,
) {
  const settings = readDesired(file);
  const { owner, repo, declaration: policy } = settings;
  const config = readAgentSettings(configPath);
  const localAgent = runtimeProfile(config.runtime);
  const desired = policy.enabled
    ? { ...policy, responsibleAgent: localAgent }
    : policy;
  if (action === "apply") {
    const parsed = bindingDeclarationSchema.safeParse(desired);
    if (!parsed.success)
      throw Error(parsed.error.issues[0].message + "; no request sent");
  }
  try {
    const client = loadChannelClient(configPath, config);
    const verifyTarget = <T extends { binding: z.infer<typeof record> | null }>(
      receipt: T,
    ) => {
      const { binding } = receipt;
      if (
        binding &&
        (binding.owner.toLowerCase() !== owner.toLowerCase() ||
          binding.repo.toLowerCase() !== repo.toLowerCase())
      )
        throw Error("Response identifies a different repository");
      return receipt;
    };
    const read = async () =>
      verifyTarget(
        await post(
          client,
          "/connector/v2/bindings/read",
          { owner, repo },
          z.object({ binding: record.nullable(), coverage: coverageSchema }),
          fetcher,
        ),
      );
    let { binding, coverage } = await read();
    if (action === "apply") {
      const previous = binding;
      try {
        ({ binding, coverage } = verifyTarget(
          await post(
            client,
            "/connector/v2/bindings/apply",
            {
              owner,
              repo,
              expectedRevision: binding?.revision ?? 0,
              declaration: desired,
            },
            z.object({ binding: record, coverage: coverageSchema }),
            fetcher,
          ),
        ));
        if (
          !sameDeclaration(binding, desired) ||
          binding.revision !==
            (previous
              ? previous.revision + Number(!sameDeclaration(previous, desired))
              : 1) ||
          (previous &&
            (previous.installationId !== binding.installationId ||
              previous.repositoryId !== binding.repositoryId ||
              previous.deviceId !== binding.deviceId ||
              previous.administratorId !== binding.administratorId))
        )
          throw Error("Apply receipt does not confirm the requested binding");
        try {
          rememberActivityBinding(
            config.stateFile,
            client.baseUrl,
            localAgent,
            binding,
          );
        } catch {
          throw new LocalInboxFailure(
            "Server binding confirmed, but saving the local activity subscription failed; check the state file, then apply again",
          );
        }
      } catch (error) {
        if (!(error instanceof BindingConflict)) throw error;
        const { binding: current } = await read();
        throw new ConfirmedConflict(
          "Binding conflict; no retry. " + JSON.stringify({ current, desired }),
        );
      }
    }
    const matches = binding && sameDeclaration(binding, desired);
    const state = desired.enabled
      ? matches
        ? "active"
        : "local_pending"
      : binding?.enabled === false
        ? "disabled"
        : "disable_pending";
    const agent = binding?.responsibleAgent;
    const filter = binding ? effectiveEvents(binding) : [];
    const capabilities = ["deepReview", "nativeReview"] as const;
    let localActivityInbox:
      | ReturnType<typeof activityInboxStatus>
      | "unavailable" = null;
    if (binding?.enabled) {
      try {
        const inbox = activityInboxStatus(
          config.stateFile,
          client.baseUrl,
          localAgent,
          owner,
          repo,
        );
        if (
          inbox?.bindingId ===
          [
            binding.installationId,
            binding.repositoryId,
            binding.deviceId,
            binding.revision,
          ].join(":")
        )
          localActivityInbox = inbox;
      } catch {
        localActivityInbox = "unavailable";
      }
    }
    return {
      repository: owner + "/" + repo,
      localAgent,
      localActivityInbox,
      desired,
      state,
      binding,
      effective: {
        responsibleAgent: agent ? agent.type + "/" + agent.id : null,
        channelEventFilter: filter,
        eventCoverage: eventCoverage(filter, coverage),
        channelSupported: bindingEvent.options,
        subscribedFamiliesOutsideChannel:
          coverage.subscriptions?.filter(
            (f) => !bindingEvent.options.some((e) => e.split(".")[0] === f),
          ) ?? "unknown",
        appSubscriptions: coverage.subscriptions ?? "unknown",
        installationEventPermissions: coverage.permissions ?? "unknown",
        runtimePoll: coverage.runtimePoll,
        explicitDelegation: !!binding?.enabled,
        autoTriage: !!(binding?.enabled && binding.autoTriage),
        autoReview: !!(binding?.enabled && binding.autoReview),
        triggerLabel: binding?.enabled ? (binding.triggerLabel ?? null) : null,
        reviewCapabilities: capabilities.filter(
          (k) => binding?.enabled && binding[k] && agent?.[k],
        ),
        missingCapabilities: capabilities.filter(
          (k) => binding?.enabled && binding[k] && !agent?.[k],
        ),
        serverWriteProfile: coverage.serverWriteProfile ?? "unknown",
      },
    };
  } catch (error) {
    if (
      error instanceof ConfirmedConflict ||
      error instanceof LocalInboxFailure
    )
      throw error;
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
