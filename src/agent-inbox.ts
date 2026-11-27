import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { activityPageSchema } from "./activity-feed.js";
import type { RuntimeProfile } from "./runtime-profile.js";
import { requireSchemaVersion } from "./store-schema.js";

type Connection = { baseUrl: string; timeout: number; token: string };
type Binding = {
  owner: string;
  repo: string;
  deviceId: string;
  installationId: number;
  repositoryId: number;
  revision: number;
  enabled: boolean;
};
type Entry = Binding & { seq: number; cursor: number };
type Wait = { revision: number; until: number; failures: number };
const PAGE = 25;
const MAX_BYTES = 256 * 1024;
const POLL_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MS = 60_000;
const MAX_RETRY_MS = 15 * 60_000;
const profileKey = (p: RuntimeProfile) =>
  JSON.stringify([p.type, p.id, p.deepReview, p.nativeReview]);
const bindingKey = (b: Binding) =>
  [b.installationId, b.repositoryId, b.deviceId, b.revision].join(":");

async function pageBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("No activity receipt");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw Error("Activity receipt exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

/** Stores only confirmed registrations and consumption progress, never event bodies. */
export class ActivityInbox {
  readonly #db: DatabaseSync;
  readonly #wait = new Map<number, Wait>();
  #last = 0;
  constructor(stateFile: string) {
    const path = stateFile + ".inbox";
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
      const exists = requireSchemaVersion(
        this.#db,
        {
          bindings: [
            "seq",
            "origin",
            "installationId",
            "repositoryId",
            "deviceId",
            "revision",
            "enabled",
            "owner",
            "repo",
            "profile",
            "cursor",
            "totalReceived",
            "retentionTruncated",
            "lastSyncedAt",
            "pollStatus",
          ],
        },
        1,
      );
      if (!exists)
        this.#db.exec(`CREATE TABLE bindings(
          seq INTEGER PRIMARY KEY, origin TEXT NOT NULL, installationId INTEGER NOT NULL,
          repositoryId INTEGER NOT NULL, deviceId TEXT NOT NULL, revision INTEGER NOT NULL,
          enabled INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, profile TEXT NOT NULL,
          cursor INTEGER NOT NULL DEFAULT 0, totalReceived INTEGER NOT NULL DEFAULT 0,
          retentionTruncated INTEGER NOT NULL DEFAULT 0, lastSyncedAt INTEGER,
          pollStatus TEXT NOT NULL DEFAULT 'not_yet_polled' CHECK(pollStatus IN ('not_yet_polled','synced','denied','unconfirmed')),
          UNIQUE(origin,installationId,repositoryId,deviceId)
        ) STRICT; PRAGMA user_version=1;`);
      this.#db.exec("COMMIT");
      chmodSync(path, 0o600);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close() {
    this.#db.close();
  }
  remember(baseUrl: string, profile: RuntimeProfile, b: Binding) {
    this.#db
      .prepare(
        `INSERT INTO bindings(origin,installationId,repositoryId,deviceId,revision,enabled,owner,repo,profile)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(origin,installationId,repositoryId,deviceId) DO UPDATE SET
      revision=excluded.revision, enabled=excluded.enabled, owner=excluded.owner, repo=excluded.repo,
      profile=excluded.profile, cursor=0, totalReceived=0, retentionTruncated=0, lastSyncedAt=NULL, pollStatus='not_yet_polled'
      WHERE excluded.revision>bindings.revision`,
      )
      .run(
        new URL(baseUrl).origin,
        b.installationId,
        b.repositoryId,
        b.deviceId,
        b.revision,
        Number(b.enabled),
        b.owner,
        b.repo,
        profileKey(profile),
      );
  }
  status(
    baseUrl: string,
    profile: RuntimeProfile,
    owner: string,
    repo: string,
  ) {
    const b = this.#db
      .prepare(
        `SELECT *, CASE WHEN retentionTruncated=1 THEN 1 ELSE 0 END AS retainedGap
      FROM bindings WHERE origin=? AND profile=? AND owner=? COLLATE NOCASE AND repo=? COLLATE NOCASE
      AND enabled=1 ORDER BY seq DESC LIMIT 1`,
      )
      .get(new URL(baseUrl).origin, profileKey(profile), owner, repo);
    return b
      ? {
          bindingId: bindingKey(b as unknown as Binding),
          pollStatus: String(b.pollStatus),
          cursor: b.pollStatus === "denied" ? null : Number(b.cursor),
          totalReceived:
            b.pollStatus === "denied" ? null : Number(b.totalReceived),
          retentionTruncated:
            b.pollStatus === "denied" ? null : b.retainedGap === 1,
          lastSyncedAt: b.lastSyncedAt === null ? null : Number(b.lastSyncedAt),
        }
      : null;
  }
  async pollOne(
    connection: Connection,
    profile: RuntimeProfile,
    stop: AbortSignal,
    fetcher: typeof fetch = fetch,
  ) {
    stop.throwIfAborted();
    const origin = new URL(connection.baseUrl).origin;
    const profileId = profileKey(profile);
    const now = Date.now();
    const eligible = (
      this.#db
        .prepare(
          `SELECT * FROM bindings WHERE origin=? AND profile=? AND enabled=1 ORDER BY seq`,
        )
        .all(origin, profileId) as unknown as Entry[]
    ).filter((entry) => {
      const wait = this.#wait.get(entry.seq);
      return !wait || wait.revision !== entry.revision || wait.until <= now;
    });
    const binding =
      eligible.find((entry) => entry.seq > this.#last) ?? eligible[0];
    if (!binding) return undefined;
    this.#last = binding.seq; // A denied or slow repository does not starve another.
    const bindingId = bindingKey(binding);
    const signal = AbortSignal.any([
      stop,
      AbortSignal.timeout(Math.min(connection.timeout, 15_000)),
    ]);
    const postpone = (failed: boolean) => {
      const previous = this.#wait.get(binding.seq);
      const failures = failed
        ? Math.min(
            5,
            1 +
              (previous?.revision === binding.revision ? previous.failures : 0),
          )
        : 0;
      const duration = failed
        ? Math.min(MAX_RETRY_MS, IDLE_INTERVAL_MS * 2 ** (failures - 1))
        : IDLE_INTERVAL_MS;
      this.#wait.set(binding.seq, {
        revision: binding.revision,
        until: Date.now() + duration,
        failures,
      });
    };
    const mark = (status: "denied" | "unconfirmed") => {
      this.#db
        .prepare(
          `UPDATE bindings SET pollStatus=?,lastSyncedAt=CASE WHEN ?='denied' THEN NULL ELSE lastSyncedAt END
        WHERE seq=? AND revision=? AND enabled=1 AND cursor=?`,
        )
        .run(status, status, binding.seq, binding.revision, binding.cursor);
      postpone(true);
    };
    try {
      const response = await fetcher(
        new URL("/connector/v2/activities", origin),
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + connection.token,
          },
          body: JSON.stringify({
            owner: binding.owner,
            repo: binding.repo,
            runtime: profile,
            after: binding.cursor,
            limit: PAGE,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        // Do not report historical local data as freshly verified after a denial.
        mark(
          [401, 403, 404, 409].includes(response.status)
            ? "denied"
            : "unconfirmed",
        );
        return undefined;
      }
      const {
        bindingId: confirmed,
        activities,
        nextCursor,
        hasMore,
        truncated,
      } = activityPageSchema.parse(await pageBody(response));
      signal.throwIfAborted();
      if (
        confirmed !== bindingId ||
        nextCursor < binding.cursor ||
        activities.length > PAGE ||
        (hasMore && activities.length !== PAGE) ||
        activities.some(
          (a, i) =>
            a.bindingId !== bindingId ||
            a.installationId !== binding.installationId ||
            a.repositoryId !== binding.repositoryId ||
            a.owner !== binding.owner ||
            a.repo !== binding.repo ||
            a.cursor <= (activities[i - 1]?.cursor ?? binding.cursor) ||
            a.cursor > nextCursor,
        ) ||
        (!truncated &&
          nextCursor !== (activities.at(-1)?.cursor ?? binding.cursor))
      )
        throw Error(
          "Activity receipt does not match the registered binding and cursor",
        );
      const changed = this.#db
        .prepare(
          `UPDATE bindings SET cursor=?,totalReceived=totalReceived+?,
      retentionTruncated=MAX(retentionTruncated,?),lastSyncedAt=?,pollStatus='synced'
      WHERE seq=? AND revision=? AND enabled=1 AND cursor=?`,
        )
        .run(
          nextCursor,
          activities.length,
          Number(truncated),
          Date.now(),
          binding.seq,
          binding.revision,
          binding.cursor,
        );
      if (!changed.changes) return undefined;
      if (nextCursor > binding.cursor) this.#wait.delete(binding.seq);
      else postpone(false);
      return { received: activities.length, truncated };
    } catch (error) {
      if (!stop.aborted) mark("unconfirmed");
      throw error;
    }
  }
}

export function rememberActivityBinding(
  stateFile: string,
  baseUrl: string,
  profile: RuntimeProfile,
  binding: Binding,
) {
  const inbox = new ActivityInbox(stateFile);
  try {
    inbox.remember(baseUrl, profile, binding);
  } finally {
    inbox.close();
  }
}

export function activityInboxStatus(
  stateFile: string,
  baseUrl: string,
  profile: RuntimeProfile,
  owner: string,
  repo: string,
) {
  if (!existsSync(stateFile + ".inbox")) return null;
  const inbox = new ActivityInbox(stateFile);
  try {
    return inbox.status(baseUrl, profile, owner, repo);
  } finally {
    inbox.close();
  }
}

export async function runActivityInbox(
  stateFile: string,
  connection: Connection,
  profile: RuntimeProfile,
  signal: AbortSignal,
) {
  const inbox = new ActivityInbox(stateFile);
  try {
    while (!signal.aborted) {
      // No LLM, task claiming, or memoization of observations here.
      await inbox.pollOne(connection, profile, signal).catch(() => undefined);
      try {
        await delay(POLL_INTERVAL_MS, undefined, { signal });
      } catch {
        if (!signal.aborted) throw Error("Activity poll interrupted");
      }
    }
  } finally {
    inbox.close();
  }
}
