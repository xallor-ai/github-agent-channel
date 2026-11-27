import type { DatabaseSync } from "node:sqlite";
import type { NewTask } from "./contracts.js";
import { fenceReviewGeneration } from "./review-lineage.js";

type Create = (
  key: string,
  input?: NewTask,
  time?: number,
  receivedAt?: number,
) => string;
type Prior = {
  id: string;
  bindingId: string;
  status: string;
  githubTime: number | null;
};

export function expireReviewPayloads(db: DatabaseSync, now: number) {
  // The small event identity survives expiry; the copy of the original
  // delegation does not depend on a busy repository sending another webhook.
  db.prepare(
    "UPDATE reviewEvents SET input=NULL WHERE deliveryId IN (SELECT deliveryId FROM reviewEvents WHERE input IS NOT NULL AND receivedAt<=? ORDER BY receivedAt LIMIT 64)",
  ).run(now - 86_400_000);
}

export function admitReview(
  db: DatabaseSync,
  input: NewTask,
  version: string,
  githubTime: number | undefined,
  cutoff: number | undefined,
  prior: Prior | undefined,
  create: Create,
) {
  const target = input.target;
  if (target.kind !== "pull_request") throw Error("No review target");
  const scope = [input.bindingId, target.number] as const;
  const floor = cutoff ?? -1,
    now = Date.now();
  db.prepare(
    "INSERT INTO reviewEvents(deliveryId,bindingId,number,version,githubTime,receivedAt,actorId,input) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    input.deliveryId,
    ...scope,
    version,
    githubTime ?? null,
    now,
    input.actorId,
    JSON.stringify(input),
  );
  // Keep compact version evidence indefinitely, but only bounded live payloads for
  // generation repair. An expired or evicted payload is never reconstructed from an excerpt.
  db.prepare(
    "UPDATE reviewEvents SET input=NULL WHERE deliveryId IN (SELECT deliveryId FROM reviewEvents WHERE bindingId=? AND input IS NOT NULL ORDER BY receivedAt DESC,rowid DESC LIMIT -1 OFFSET 1024)",
  ).run(input.bindingId);
  const source = (id: string) =>
    db.prepare("SELECT id,githubTime FROM tasks WHERE deliveryId=?").get(id);
  function neighbors(key: string, time: number) {
    const range = db
      .prepare(
        "SELECT max(CASE WHEN githubTime<? THEN githubTime END) lo,min(CASE WHEN githubTime>? THEN githubTime END) hi FROM reviewEvents WHERE bindingId=? AND number=? AND version!=? AND githubTime>?",
      )
      .get(time, time, ...scope, key, floor)!;
    return {
      lo: Number(range.lo ?? floor),
      hi: Number(range.hi ?? Number.MAX_SAFE_INTEGER),
    };
  }
  const ambiguous = (key: string, time: number | null) =>
    !!db
      .prepare(
        "SELECT 1 FROM reviewEvents WHERE bindingId=? AND number=? AND version!=? AND (githubTime IS NULL OR githubTime=? OR (? IS NULL AND githubTime>?)) LIMIT 1",
      )
      .get(...scope, key, time, time, floor);
  function pivot(time: number) {
    return db
      .prepare(
        "SELECT deliveryId FROM reviewEvents WHERE bindingId=? AND number=? AND githubTime=? AND version!=? ORDER BY deliveryId LIMIT 1",
      )
      .get(...scope, time, version)?.deliveryId;
  }
  let task: string | null = null,
    reused = false;
  if (!prior) {
    task = create(version);
  } else if (prior.bindingId !== input.bindingId) {
    task = prior.id;
    reused = true;
  } else if (ambiguous(version, githubTime ?? null)) {
    fenceReviewGeneration(db, prior.id, null, githubTime ?? 0, null);
    reused = true;
  } else if (githubTime === undefined) {
    reused = true;
    if (!blocked(prior.id)) task = prior.id;
  } else {
    const { lo, hi } = neighbors(version, githubTime);
    const reps = db
      .prepare(
        "SELECT id FROM tasks WHERE bindingId=? AND eventKey=? AND (githubTime IS NULL OR (githubTime>? AND githubTime<?)) LIMIT 2",
      )
      .all(input.bindingId, version, lo, hi);
    if (reps.length) {
      reused = true;
      if (reps.length === 1 && !blocked(String(reps[0].id)))
        task = String(reps[0].id);
    } else if (
      prior.githubTime !== null &&
      prior.githubTime < lo &&
      lo > floor
    ) {
      task = create(version);
      fenceReviewGeneration(db, prior.id, String(pivot(lo)), githubTime, task);
    } else reused = true;
  }
  function blocked(id: string) {
    return db
      .prepare(
        "SELECT 1 FROM reviewDrifts WHERE taskId=? UNION ALL SELECT 1 FROM reviewGenerations WHERE oldTaskId=? LIMIT 1",
      )
      .get(id, id);
  }
  if (task && !reused)
    db.prepare("UPDATE reviewEvents SET input=NULL WHERE deliveryId=?").run(
      input.deliveryId,
    );
  // A late, intervening event may split previously coalesced occurrences. Repair
  // the right-hand segment from its own signed source, never by copying a lease.
  {
    const timePoint = githubTime ?? null;
    const stale = db
      .prepare(
        `SELECT e.*,t.id oldId,t.githubTime oldTime,d.cursor FROM reviewEvents e JOIN deliveries d ON d.deliveryId=e.deliveryId JOIN tasks t ON t.id=d.taskId
   WHERE e.bindingId=? AND e.number=? AND e.version!=? AND t.bindingId=e.bindingId AND d.duplicate=1 AND coalesce(e.githubTime,0)>? AND coalesce(t.githubTime,0)>?
   AND (? IS NULL OR e.githubTime IS NULL OR t.githubTime IS NULL OR (t.githubTime<? AND e.githubTime>=?) OR (t.githubTime>? AND e.githubTime<=?) OR t.githubTime=?) ORDER BY e.githubTime,e.deliveryId`,
      )
      .all(
        ...scope,
        version,
        floor,
        floor,
        timePoint,
        timePoint,
        timePoint,
        timePoint,
        timePoint,
        timePoint,
      );
    for (const r of stale) {
      const time = Number(r.githubTime),
        key = String(r.version),
        oldId = String(r.oldId);
      const { lo, hi } = neighbors(key, time);
      let fresh: string | null = null;
      if (
        githubTime !== undefined &&
        r.oldTime !== null &&
        r.githubTime !== null &&
        Number(r.oldTime) < githubTime &&
        time > githubTime &&
        !ambiguous(key, time)
      ) {
        const rep = db
          .prepare(
            "SELECT id FROM tasks WHERE bindingId=? AND eventKey=? AND githubTime>? AND githubTime<? LIMIT 1",
          )
          .get(input.bindingId, key, lo, hi);
        if (rep && !blocked(String(rep.id))) fresh = String(rep.id);
        else if (!rep && r.input && Number(r.receivedAt) > now - 86400000)
          fresh = create(
            key,
            JSON.parse(String(r.input)),
            time,
            Number(r.receivedAt),
          );
        fenceReviewGeneration(db, oldId, input.deliveryId, time, fresh);
      } else if (
        githubTime === undefined ||
        r.githubTime === null ||
        r.oldTime === null ||
        (Number(r.oldTime) <= githubTime && time >= githubTime)
      )
        fenceReviewGeneration(db, oldId, null, time, null);
      db.prepare(
        "UPDATE deliveries SET taskId=?,reviewFollowUp=?,duplicate=CASE WHEN deliveryId=? AND ? IS NOT NULL THEN 0 ELSE 1 END WHERE cursor=? AND taskId=?",
      ).run(
        fresh,
        fresh ? null : "review_generation_unconfirmed",
        fresh && source(String(r.deliveryId)) ? String(r.deliveryId) : "",
        fresh,
        r.cursor!,
        oldId,
      );
      db.prepare(
        "UPDATE activities SET data=json_set(data,'$.taskId',?) WHERE cursor=?",
      ).run(fresh, r.cursor!);
      db.prepare(
        "DELETE FROM reviewCandidates WHERE taskId=? AND githubTime=?",
      ).run(oldId, time);
      if (fresh && source(String(r.deliveryId)))
        db.prepare("UPDATE reviewEvents SET input=NULL WHERE deliveryId=?").run(
          r.deliveryId!,
        );
    }
  }
  return { taskId: task, reused, unconfirmed: reused && task === null };
}
