import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { activityPageSchema, receivedPageSchema } from "./activity-feed.js";
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
const RETAIN = 256;
const expiredReceipt = z
  .strictObject({
    bindingId: receivedPageSchema.shape.bindingId,
    expired: receivedPageSchema.shape.entries,
  })
  .transform(({ bindingId, expired: entries }) => ({ bindingId, entries }));
type Activity = z.infer<typeof activityPageSchema>["activities"][number];
type InboxRow = {
  activity: Activity;
  ack: "pending" | "confirmed" | "expired";
};

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

/** Stores bounded, consumable activity excerpts before acknowledging their receipt. */
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
          received: ["seq", "cursor", "deliveryId", "data", "ack"],
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
        2,
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
        ) STRICT; CREATE TABLE received(seq INTEGER NOT NULL,cursor INTEGER NOT NULL,deliveryId TEXT NOT NULL,
        data TEXT NOT NULL,ack TEXT NOT NULL CHECK(ack IN ('pending','confirmed','expired')),PRIMARY KEY(seq,cursor), UNIQUE(seq,deliveryId)) STRICT;
        CREATE TRIGGER reset_received AFTER UPDATE OF revision ON bindings WHEN NEW.revision!=OLD.revision BEGIN DELETE FROM received WHERE seq=NEW.seq; END;
        PRAGMA user_version=2;`);
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
  records(
    baseUrl: string,
    profile: RuntimeProfile,
    b: Binding,
    after: number,
    limit: number,
  ) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Error("Invalid inbox page");
    if (!b.enabled) return null;
    // Keep binding validation and page lookup in one SQLite snapshot.
    return this.transaction(() => {
      const selected = this.#db
        .prepare(
          "SELECT seq, retentionTruncated FROM bindings WHERE origin=? AND profile=? AND installationId=? AND repositoryId=? AND deviceId=? AND revision=? AND owner=? AND repo=? AND enabled=1 AND pollStatus!='denied'",
        )
        .get(
          new URL(baseUrl).origin,
          profileKey(profile),
          b.installationId,
          b.repositoryId,
          b.deviceId,
          b.revision,
          b.owner,
          b.repo,
        );
      if (!selected) return null;
      const rows = this.#db
        .prepare(
          "SELECT data,ack FROM received WHERE seq=? AND cursor>? ORDER BY cursor LIMIT ?",
        )
        .all(Number(selected.seq), after, limit + 1);
      const activities: InboxRow[] = rows.slice(0, limit).map((r) => ({
        activity: JSON.parse(String(r.data)) as Activity,
        ack: r.ack as InboxRow["ack"],
      }));
      return {
        bindingId: bindingKey(b),
        retentionTruncated: !!selected.retentionTruncated,
        activities,
        nextCursor: activities.at(-1)?.activity.cursor ?? after,
        hasMore: rows.length > limit,
      };
    });
  }
  private transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const ret = fn();
      this.#db.exec("COMMIT");
      return ret;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
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
      const entries = this.#db
        .prepare(
          "SELECT cursor,deliveryId FROM received WHERE seq=? AND ack='pending' ORDER BY cursor LIMIT ?",
        )
        .all(binding.seq, PAGE)
        .map((r) => ({
          cursor: Number(r.cursor),
          deliveryId: String(r.deliveryId),
        }));
      const ack = entries.length > 0;
      const response = await fetcher(
        new URL(
          ack
            ? "/connector/v2/activities/received"
            : "/connector/v2/activities",
          origin,
        ),
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
            ...(ack
              ? { bindingId, entries }
              : { after: binding.cursor, limit: PAGE }),
          }),
        },
      );
      if (ack && (response.status === 200 || response.status === 410)) {
        const expired = response.status === 410;
        const raw = await pageBody(response);
        const receipt = (expired ? expiredReceipt : receivedPageSchema).parse(
          raw,
        );
        const result = receipt.entries;
        if (receipt.bindingId !== bindingId)
          throw Error(
            "Activity acknowledgement differs from registered binding",
          );
        signal.throwIfAborted();
        if (
          expired
            ? !result.every((r) =>
                entries.some(
                  (e) => e.cursor === r.cursor && e.deliveryId === r.deliveryId,
                ),
              )
            : result.length !== entries.length ||
              !result.every(
                (r, i) =>
                  entries[i].cursor === r.cursor &&
                  entries[i].deliveryId === r.deliveryId,
              )
        )
          throw Error(
            "Activity acknowledgement differs from submitted receipts",
          );
        this.transaction(() => {
          const changed = this.#db
            .prepare(
              "UPDATE bindings SET lastSyncedAt=?,pollStatus='synced',retentionTruncated=MAX(retentionTruncated,?) WHERE seq=? AND revision=? AND enabled=1",
            )
            .run(Date.now(), Number(expired), binding.seq, binding.revision);
          if (!changed.changes) return;
          const update = this.#db.prepare(
            "UPDATE received SET ack=? WHERE seq=? AND cursor=? AND deliveryId=? AND ack='pending'",
          );
          for (const e of result)
            update.run(
              expired ? "expired" : "confirmed",
              binding.seq,
              e.cursor,
              e.deliveryId,
            );
        });
        this.#wait.delete(binding.seq);
        return { received: 0, truncated: expired };
      }
      if (!response.ok || ack) {
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
            a.deliveryId.length > 100 ||
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
      const stored = this.transaction(() => {
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
        if (!changed.changes) return false;
        const put = this.#db.prepare(
          "INSERT INTO received(seq,cursor,deliveryId,data,ack) VALUES(?,?,?,?,'pending')",
        );
        for (const a of activities)
          put.run(binding.seq, a.cursor, a.deliveryId, JSON.stringify(a));
        const evicted = this.#db
          .prepare(
            "DELETE FROM received WHERE seq=? AND ack!='pending' AND cursor<=(SELECT cursor FROM received WHERE seq=? ORDER BY cursor DESC LIMIT 1 OFFSET ?)",
          )
          .run(binding.seq, binding.seq, RETAIN);
        if (evicted.changes)
          this.#db
            .prepare("UPDATE bindings SET retentionTruncated=1 WHERE seq=?")
            .run(binding.seq);
        return true;
      });
      if (!stored) return undefined;
      if (nextCursor > binding.cursor) this.#wait.delete(binding.seq);
      else postpone(false);
      return { received: activities.length, truncated };
    } catch (error) {
      if (!stop.aborted) mark("unconfirmed");
      throw error;
    }
  }
}

/** Callers must supply the current binding just verified by the authenticated server. */
export function readActivityInbox(
  stateFile: string,
  baseUrl: string,
  profile: RuntimeProfile,
  binding: Binding,
  after = 0,
  limit = 25,
) {
  if (!existsSync(stateFile + ".inbox")) return null;
  const inbox = new ActivityInbox(stateFile);
  try {
    return inbox.records(baseUrl, profile, binding, after, limit);
  } finally {
    inbox.close();
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
