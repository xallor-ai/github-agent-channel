import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AdministratorLost,
  BindingPrincipalVerifier,
} from "./binding-principal.js";
import {
  bindingDeclarationSchema,
  type BindingRegistry,
} from "./binding-registry.js";
import type { TaskStore } from "./store.js";
import { feedQueryFields } from "./activity-feed.js";
import { sameRuntimeIdentity, type RuntimeProfile } from "./runtime-profile.js";
import { AccessDenied } from "./contracts.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const githubId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const principal = z.object({ deviceId: z.uuid(), githubUserId: githubId });
const target = z.strictObject({
  owner: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,100}$/)
    .refine((s) => s !== "." && s !== ".."),
});
const feedQuery = target.extend(feedQueryFields);
const update = target.extend({
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  declaration: bindingDeclarationSchema,
});
const paths = {
  invite: "/admin/device-invites",
  revoke: "/admin/device-revoke",
  pair: "/connector/v2/devices/pair",
  read: "/connector/v2/bindings/read",
  apply: "/connector/v2/bindings/apply",
  activities: "/connector/v2/activities",
};
function matchesActivityBinding(
  binding: ReturnType<BindingRegistry["get"]>,
  runtime: RuntimeProfile,
) {
  const agent = binding?.responsibleAgent;
  return (
    binding?.enabled === true &&
    agent !== undefined &&
    sameRuntimeIdentity(agent, runtime) &&
    agent.deepReview === runtime.deepReview &&
    agent.nativeReview === runtime.nativeReview
  );
}
type VerifiedPrincipal = Parameters<BindingRegistry["apply"]>[0];
function sameBindingIdentity(a: VerifiedPrincipal, b: VerifiedPrincipal) {
  return (
    a.installationId === b.installationId &&
    a.repositoryId === b.repositoryId &&
    a.deviceId === b.deviceId &&
    a.administratorId === b.administratorId &&
    a.owner === b.owner &&
    a.repo === b.repo
  );
}
const layout = [
  "CREATE TABLE devices(deviceId TEXT PRIMARY KEY, githubUserId INTEGER NOT NULL, credential BLOB NOT NULL UNIQUE, revoked INTEGER NOT NULL CHECK(revoked IN(0,1,2))) STRICT",
  "CREATE TABLE invites(digest BLOB PRIMARY KEY, githubUserId INTEGER NOT NULL, expiresAt INTEGER NOT NULL) STRICT",
];
class Rejection extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 8192) throw new Rejection(400, "invalid_request");
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Rejection(400, "invalid_request");
  }
}

type Options = {
  runtimeLastSeen?: TaskStore["runtimeLastSeen"];
  recentActivities?: TaskStore["activitiesForDevice"];
  dbPath: string;
  adminToken: string;
  appId: string;
  privateKey: string;
  registry: BindingRegistry;
  hasWriteProfile?: (installationId: number, repositoryId: number) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class DeviceService {
  readonly #db: DatabaseSync;
  readonly #admin: Buffer;
  readonly #verifier: BindingPrincipalVerifier;
  readonly #registry: BindingRegistry;
  readonly #fetch: typeof fetch;
  readonly #runtimeLastSeen: Options["runtimeLastSeen"];
  readonly #recentActivities: Options["recentActivities"];
  readonly #hasWriteProfile: Options["hasWriteProfile"];
  readonly #now: () => number;
  constructor(options: Options) {
    this.#runtimeLastSeen = options.runtimeLastSeen;
    this.#recentActivities = options.recentActivities;
    this.#hasWriteProfile = options.hasWriteProfile;
    this.#admin = digest(options.adminToken);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#registry = options.registry;
    this.#verifier = new BindingPrincipalVerifier(
      options.appId,
      options.privateKey,
      async (token) => this.authenticate(token),
      this.#fetch,
    );
    if (options.dbPath !== ":memory:")
      mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(options.dbPath);
    try {
      this.#transaction(() => {
        const objects = this.#db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
          )
          .all();
        const app = this.#db
          .prepare("PRAGMA application_id")
          .get()?.application_id;
        const version = this.#db
          .prepare("PRAGMA user_version")
          .get()?.user_version;
        if (!objects.length && app === 0 && version === 0) {
          for (const sql of layout) this.#db.exec(sql);
          this.#db.exec(
            "PRAGMA application_id=1146504003;PRAGMA user_version=1",
          );
        } else if (
          app !== 1146504003 ||
          version !== 1 ||
          objects.length !== layout.length ||
          !objects.every((v, i) => v.sql === layout[i])
        ) {
          throw Error(
            "Expected dedicated device database; existing data left intact",
          );
        }
      });
      if (options.dbPath !== ":memory:") chmodSync(options.dbPath, 0o600);
      // A crash after disabling a credential cannot resurrect it. Finish fencing
      // its queues before accepting requests on the next startup.
      for (const row of this.#db
        .prepare("SELECT deviceId FROM devices WHERE revoked=1")
        .all())
        this.#finishRevoke(String(row.deviceId));
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close() {
    this.#db.close();
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  authenticate(credential: string) {
    if (!secret.safeParse(credential).success) return undefined;
    const row = this.#db
      .prepare(
        "SELECT deviceId,githubUserId FROM devices WHERE credential=? AND revoked=0",
      )
      .get(digest(credential));
    return row ? principal.parse(row) : undefined;
  }
  principalForDevice(deviceId: string) {
    const row = this.#db
      .prepare(
        "SELECT deviceId,githubUserId FROM devices WHERE deviceId=? AND revoked=0",
      )
      .get(deviceId);
    return row ? principal.parse(row) : undefined;
  }
  isActive(deviceId: string) {
    return Boolean(this.principalForDevice(deviceId));
  }
  #finishRevoke(deviceId: string) {
    this.#registry.revokeDevice(deviceId);
    this.#db
      .prepare("UPDATE devices SET revoked=2 WHERE deviceId=?")
      .run(deviceId);
  }
  #revoke(deviceId: string) {
    const row = this.#db
      .prepare("SELECT revoked FROM devices WHERE deviceId=?")
      .get(deviceId);
    if (!row) throw new Rejection(404, "device_not_found");
    if (row.revoked === 2) return;
    this.#db
      .prepare("UPDATE devices SET revoked=1 WHERE deviceId=?")
      .run(deviceId);
    this.#finishRevoke(deviceId);
  }
  #invite(githubUserId: number) {
    const invite = randomBytes(32).toString("base64url");
    const now = this.#now(),
      expiresAt = now + 600000;
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM invites WHERE expiresAt<=?").run(now);
      this.#db
        .prepare("INSERT INTO invites VALUES(?,?,?)")
        .run(digest(invite), githubUserId, expiresAt);
    });
    return { invite, expiresAt };
  }
  async #pair(invite: string, deviceToken: string, githubToken: string) {
    const key = digest(invite);
    const record = this.#db
      .prepare(
        "SELECT githubUserId FROM invites WHERE digest=? AND expiresAt>?",
      )
      .get(key, this.#now());
    if (!record) throw new Rejection(403, "invite_invalid");
    let githubUserId: number;
    try {
      const response = await this.#fetch("https://api.github.com/user", {
        headers: {
          Authorization: "Bearer " + githubToken,
          Accept: "application/vnd.github+json",
          "User-Agent": "github-agent-channel",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if ([401, 403].includes(response.status))
        throw new Rejection(403, "github_identity");
      if (!response.ok) throw Error();
      githubUserId = z.object({ id: githubId }).parse(await response.json()).id;
    } catch (e) {
      throw e instanceof Rejection
        ? e
        : new Rejection(502, "github_unavailable");
    }
    if (githubUserId !== record.githubUserId)
      throw new Rejection(403, "github_identity");
    const deviceId = randomUUID();
    this.#transaction(() => {
      if (
        this.#db
          .prepare(
            "DELETE FROM invites WHERE digest=? AND githubUserId=? AND expiresAt>?",
          )
          .run(key, githubUserId, this.#now()).changes !== 1
      )
        throw new Rejection(403, "invite_invalid");
      if (
        this.#db
          .prepare("SELECT 1 FROM devices WHERE credential=?")
          .get(digest(deviceToken))
      )
        throw new Rejection(409, "binding_conflict");
      this.#db
        .prepare("INSERT INTO devices VALUES(?,?,?,0)")
        .run(deviceId, githubUserId, digest(deviceToken));
    });
    return { deviceId, githubUserId };
  }
  async #verify(
    credential: string,
    input: z.infer<typeof target>,
    before: ReturnType<BindingRegistry["ownedSelections"]>,
  ) {
    try {
      return await this.#verifier.verify(credential, input);
    } catch (e) {
      if (e instanceof AdministratorLost) {
        const affected = before.find(
          (b) =>
            e.repositoryId === b.repositoryId &&
            e.installationId === b.installationId,
        );
        if (affected) this.#registry.disableIfCurrent(affected);
      }
      if (e instanceof AccessDenied) {
        if (e.message === "Device is not paired")
          throw new Rejection(401, "device_unauthorized");
        if (
          e.message.includes("administrator") ||
          e.message.includes("user identity")
        )
          throw new Rejection(403, "administrator_permission");
        throw new Rejection(403, "installation_scope");
      }
      const remote = z
        .object({ status: z.number(), request: z.object({ url: z.string() }) })
        .safeParse(e);
      if (remote.success && [404, 422].includes(remote.data.status)) {
        throw new Rejection(
          403,
          remote.data.request.url.includes("/collaborators/") ||
          remote.data.request.url.includes("/user/")
            ? "administrator_permission"
            : "installation_scope",
        );
      }
      throw new Rejection(502, "github_unavailable");
    }
  }
  #runtimePoll(binding: ReturnType<BindingRegistry["get"]>) {
    if (!binding?.enabled || !binding.responsibleAgent)
      return { status: "unbound", lastPolledAt: null };
    if (!this.#runtimeLastSeen)
      return { status: "unknown", lastPolledAt: null };
    const lastPolledAt = this.#runtimeLastSeen(
      binding.deviceId,
      binding.responsibleAgent,
    );
    if (lastPolledAt === null) return { status: "never_seen", lastPolledAt };
    const age = this.#now() - lastPolledAt;
    return {
      status: age >= 0 && age <= 120_000 ? "recent" : "last_seen",
      lastPolledAt,
    };
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url;
    if (!path || !Object.values(paths).includes(path)) return false;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== "POST") throw new Rejection(405, "invalid_request");
      const credential = /^Bearer ([^\s]+)$/.exec(
        req.headers.authorization ?? "",
      )?.[1];
      if (path === paths.invite || path === paths.revoke) {
        if (!credential || !timingSafeEqual(digest(credential), this.#admin))
          throw new Rejection(401, "admin_unauthorized");
        const input = await jsonBody(req);
        if (path === paths.invite)
          send(
            201,
            this.#invite(
              z.strictObject({ githubUserId: githubId }).parse(input)
                .githubUserId,
            ),
          );
        else {
          this.#revoke(
            z.strictObject({ deviceId: z.uuid() }).parse(input).deviceId,
          );
          send(200, { revoked: true });
        }
      } else if (path === paths.pair) {
        if (!credential) throw new Rejection(401, "github_identity");
        const { invite, deviceToken } = z
          .strictObject({ invite: secret, deviceToken: secret })
          .parse(await jsonBody(req));
        send(201, await this.#pair(invite, deviceToken, credential));
      } else {
        if (!credential || !this.authenticate(credential))
          throw new Rejection(401, "device_unauthorized");
        const body = await jsonBody(req);
        const change = path === paths.apply ? update.parse(body) : undefined;
        const feed =
          path === paths.activities ? feedQuery.parse(body) : undefined;
        const selector = change ?? feed;
        const selection = selector
          ? { owner: selector.owner, repo: selector.repo }
          : target.parse(body);
        const paired = this.authenticate(credential);
        if (!paired) throw new Rejection(401, "device_unauthorized");
        const owned = this.#registry.ownedSelections(
          paired.deviceId,
          paired.githubUserId,
          selection.owner,
          selection.repo,
        );
        const before = feed
          ? owned.filter((binding) =>
              matchesActivityBinding(binding, feed.runtime),
            )
          : owned;
        if (feed && before.length === 0)
          throw new Rejection(403, "binding_owner");
        const { who, installation } = await this.#verify(
          credential,
          selection,
          before,
        );
        const coverage = {
          ...installation,
          serverWriteProfile:
            this.#hasWriteProfile?.(who.installationId, who.repositoryId) ??
            null,
        };
        // No await between the last credential/ownership checks and the registry operation.
        const device = this.authenticate(credential);
        if (
          device?.deviceId !== who.deviceId ||
          device.githubUserId !== who.administratorId
        )
          throw new Rejection(401, "device_unauthorized");
        const binding = this.#registry.get({
          installationId: who.installationId,
          repositoryId: who.repositoryId,
        });
        if (
          binding &&
          (binding.deviceId !== who.deviceId ||
            binding.administratorId !== who.administratorId)
        )
          throw new Rejection(403, "binding_owner");
        if (feed) {
          const verifiedBefore = before.find((b) =>
            sameBindingIdentity(b, who),
          );
          if (!binding || !verifiedBefore)
            throw new Rejection(403, "binding_owner");
          if (
            verifiedBefore.revision !== binding.revision ||
            !sameBindingIdentity(binding, who)
          )
            throw new Rejection(409, "binding_conflict");
          if (!matchesActivityBinding(binding, feed.runtime))
            throw new Rejection(403, "binding_owner");
          if (!this.#recentActivities)
            throw new Rejection(503, "service_error");
          const bindingId = [
            binding.installationId,
            binding.repositoryId,
            binding.deviceId,
            binding.revision,
          ].join(":");
          send(200, {
            bindingId,
            ...this.#recentActivities(
              binding.deviceId,
              feed.after,
              feed.limit,
              feed.runtime,
              bindingId,
            ),
          });
        } else if (change) {
          try {
            const updated = this.#registry.apply(
              who,
              change.expectedRevision,
              change.declaration,
            );
            send(200, {
              binding: updated,
              coverage: {
                ...coverage,
                runtimePoll: this.#runtimePoll(updated),
              },
            });
          } catch (e) {
            if (
              e instanceof Error &&
              ["Binding revision conflict", "No binding to disable"].includes(
                e.message,
              )
            )
              throw new Rejection(409, "binding_conflict");
            throw e;
          }
        } else
          send(200, {
            binding: binding ?? null,
            coverage: { ...coverage, runtimePoll: this.#runtimePoll(binding) },
          });
      }
    } catch (e) {
      if (e instanceof Rejection) send(e.status, { error: e.message });
      else if (e instanceof z.ZodError) send(400, { error: "invalid_request" });
      else send(500, { error: "service_error" });
    }
    return true;
  }
}
