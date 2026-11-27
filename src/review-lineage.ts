import type { DatabaseSync } from "node:sqlite";
import type { PullRevision, Task } from "./contracts.js";
import { revisionSchema } from "./outcomes.js";
import type { ReviewInputSummary } from "./review-input.js";

export function reviewKey(
  installationId: number,
  repositoryId: number,
  number: number,
  r: PullRevision,
) {
  return JSON.stringify([
    "review",
    installationId,
    repositoryId,
    number,
    r.baseSha,
    r.headSha,
  ]);
}

const reference = (a: PullRevision, b: PullRevision) =>
  a.baseSha === b.baseSha &&
  a.headSha === b.headSha &&
  a.baseRepoId === b.baseRepoId &&
  a.headRepoId === b.headRepoId;
// Called inside the ingress transaction. Three signed, distinct instants
// prove the old run cannot publish for this incarnation, even if its SHA is back.
export function fenceReviewGeneration(
  db: DatabaseSync,
  oldId: string,
  via: string | null,
  returnedAt: number,
  successor: string | null,
) {
  db.prepare(
    "INSERT INTO reviewGenerations VALUES(?,?,?,?) ON CONFLICT(oldTaskId) DO UPDATE SET successor=excluded.successor WHERE reviewGenerations.successor IS NULL AND reviewGenerations.via=excluded.via AND reviewGenerations.returnedAt=excluded.returnedAt",
  ).run(oldId, via, returnedAt, successor);
  db.prepare(
    "UPDATE tasks SET publicationBlocked=1,status=CASE WHEN status='queued' THEN 'rejected' ELSE status END,deliveryStatus=CASE WHEN status IN ('queued','failed','succeeded') AND deliveryStatus='pending' THEN 'skipped' ELSE deliveryStatus END,error=CASE WHEN status IN ('queued','failed','succeeded') AND deliveryStatus='pending' THEN 'Automatic review replaced by a later signed generation' ELSE error END WHERE id=?",
  ).run(oldId);
}
export class ReviewLineage {
  constructor(private readonly db: DatabaseSync) {}
  private pin(task: Task) {
    if (
      task.target.kind !== "pull_request" ||
      task.source.event !== "pull_request" ||
      !["opened", "synchronize"].includes(task.source.action ?? "")
    )
      return;
    const pin = revisionSchema.safeParse(task.target.revision);
    if (
      !pin.success ||
      pin.data.baseRepoId !== task.repositoryId ||
      pin.data.headRepoId !== task.repositoryId
    )
      return;
    const key = reviewKey(
      task.installationId,
      task.repositoryId,
      task.target.number,
      pin.data,
    );
    const row = this.db
      .prepare(
        "SELECT t.githubTime FROM tasks t JOIN reviewEvents e ON e.deliveryId=t.deliveryId AND t.eventKey=e.version AND t.actorId=e.actorId AND e.bindingId=t.bindingId AND t.githubTime IS e.githubTime WHERE t.id=? AND t.eventKey=?",
      )
      .get(task.id, key);
    if (!row) return;
    return {
      r: pin.data,
      number: task.target.number,
      time: typeof row.githubTime === "number" ? row.githubTime : null,
      key,
    };
  }
  record(task: Task, observed: PullRevision, githubObservedAt?: number) {
    const p = this.pin(task);
    const v = revisionSchema.safeParse(observed);
    if (
      !p ||
      !v.success ||
      v.data.baseRepoId !== task.repositoryId ||
      v.data.headRepoId !== task.repositoryId ||
      reference(p.r, v.data)
    )
      return false;
    this.db
      .prepare(
        "INSERT INTO reviewDrifts SELECT ?,?,?,COALESCE(MAX(cursor),0),? FROM deliveries WHERE true ON CONFLICT(taskId) DO NOTHING",
      )
      .run(
        task.id,
        JSON.stringify(v.data),
        Date.now(),
        Number.isSafeInteger(githubObservedAt) && githubObservedAt! > 0
          ? githubObservedAt!
          : null,
      );
    this.db
      .prepare("UPDATE tasks SET publicationBlocked=1 WHERE id=?")
      .run(task.id);
    if (task.status === "queued")
      this.db
        .prepare(
          "UPDATE tasks SET status='rejected',deliveryStatus='skipped',error='PR revision changed before execution' WHERE id=?",
        )
        .run(task.id);
    else if (
      (task.status === "succeeded" || task.status === "failed") &&
      task.deliveryStatus === "pending"
    )
      this.db
        .prepare(
          "UPDATE tasks SET deliveryStatus='skipped',error='PR revision changed before publication' WHERE id=?",
        )
        .run(task.id);
    return true;
  }
  hasDrift(id: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM reviewDrifts WHERE taskId=? UNION ALL SELECT 1 FROM reviewGenerations WHERE oldTaskId=? LIMIT 1",
      )
      .get(id, id);
  }
  noteClose(repositoryId: number, number: number, time: number | undefined) {
    this.db
      .prepare("INSERT OR IGNORE INTO reviewBoundaries VALUES(?,?,?)")
      .run(repositoryId, number, time ?? -1);
  }
  private separated(task: Task, number: number, start: number, end: number) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM reviewBoundaries WHERE repositoryId=? AND number=? AND (closedAt=-1 OR closedAt BETWEEN ? AND ?) LIMIT 1",
      )
      .get(task.repositoryId, number, start, end);
  }
  get(task: Task) {
    const p = this.pin(task),
      row = this.db
        .prepare("SELECT * FROM reviewDrifts WHERE taskId=?")
        .get(task.id);
    if (!p) return null;
    const witness = this.db
      .prepare("SELECT * FROM reviewGenerations WHERE oldTaskId=?")
      .get(task.id);
    const event =
      witness?.via &&
      this.db
        .prepare(
          "SELECT e.*,t.id taskId FROM reviewEvents e JOIN deliveries d ON d.deliveryId=e.deliveryId LEFT JOIN tasks t ON t.id=d.taskId AND t.bindingId=e.bindingId AND t.actorId=e.actorId AND t.eventKey=e.version WHERE e.deliveryId=? AND e.bindingId=? AND e.number=? AND e.version!=? AND e.githubTime>? AND e.githubTime<?",
        )
        .get(
          witness.via,
          task.bindingId,
          p.number,
          p.key,
          p.time,
          Number(witness.returnedAt),
        );
    const returned =
      witness &&
      this.db
        .prepare(
          "SELECT d.taskId,t.actorId expectedActor,e.actorId FROM reviewEvents e JOIN deliveries d ON d.deliveryId=e.deliveryId LEFT JOIN tasks t ON t.deliveryId=e.deliveryId WHERE e.bindingId=? AND e.number=? AND e.version=? AND e.githubTime=? ORDER BY t.id IS NOT NULL DESC LIMIT 1",
        )
        .get(task.bindingId, p.number, p.key, witness.returnedAt!);
    const generation =
      event &&
      typeof event === "object" &&
      returned &&
      witness &&
      p.time !== null &&
      !this.separated(task, p.number, p.time, Number(witness.returnedAt))
        ? {
            source: "signed_review_events",
            intermediateDeliveryId: String(event.deliveryId),
            intermediateTaskId:
              event.taskId === null ? null : String(event.taskId),
            intermediateRevision: {
              ...p.r,
              baseSha: String(JSON.parse(String(event.version))[4]),
              headSha: String(JSON.parse(String(event.version))[5]),
            },
            returnedAt: Number(witness.returnedAt),
            successorTaskId:
              returned.taskId !== null &&
              returned.taskId === witness.successor &&
              returned.expectedActor === returned.actorId
                ? String(witness.successor)
                : null,
          }
        : null;
    if (!row)
      return witness
        ? {
            previousRevision: p.r,
            observedRevision: null,
            observedAt: null,
            githubObservedAt: null,
            generation,
            successorTaskId: generation?.successorTaskId ?? null,
            reason: generation
              ? "signed_revision_return"
              : "lifecycle_uncertain",
          }
        : null;
    const observedAt = Number(row.observedAt),
      observedRevision = revisionSchema.parse(JSON.parse(String(row.observed)));
    const base = {
      previousRevision: p.r,
      observedRevision,
      observedAt,
      githubObservedAt:
        typeof row.githubObservedAt === "number" ? row.githubObservedAt : null,
      generation,
    };
    const unknown = (reason: string) => ({
      ...base,
      successorTaskId: null,
      reason,
    });
    if (p.time === null) return unknown("event_time_unknown");
    // Only signed GitHub times establish order. The read timestamp bounds the
    // observation, never a reason to order two same-second webhook events.
    const upper = base.githubObservedAt;
    const targetKey = reviewKey(
      task.installationId,
      task.repositoryId,
      p.number,
      observedRevision,
    );
    const predicate =
      "e.bindingId=? AND e.number=? AND (e.githubTime IS NULL OR e.githubTime>=?) AND (d.cursor<=? OR (? IS NOT NULL AND e.githubTime<=?))";
    const args = [task.bindingId, p.number, p.time, row.cursor!, upper, upper];
    const candidates = this.db
      .prepare(
        "SELECT t.id taskId,e.githubTime,d.cursor FROM reviewEvents e JOIN deliveries d ON e.deliveryId=d.deliveryId LEFT JOIN tasks t ON t.id=d.taskId AND t.eventKey=e.version AND t.bindingId=e.bindingId WHERE " +
          predicate +
          " AND e.version=? ORDER BY e.githubTime IS NULL DESC,e.githubTime DESC LIMIT 1",
      )
      .get(...args, targetKey);
    if (!candidates) return unknown("no_matching_task");
    const time = candidates.githubTime;
    if (
      typeof time !== "number" ||
      time <= p.time ||
      candidates.taskId === null ||
      (upper !== null &&
        (time > upper ||
          (time === upper && Number(candidates.cursor) > Number(row.cursor))))
    )
      return unknown("ambiguous_order");
    if (
      this.separated(task, p.number, p.time, upper ?? Number.MAX_SAFE_INTEGER)
    )
      return unknown("lifecycle_uncertain");
    const conflict = this.db
      .prepare(
        "SELECT 1 FROM reviewEvents e JOIN deliveries d ON d.deliveryId=e.deliveryId WHERE e.bindingId=? AND e.number=? AND (e.githubTime IS NULL OR (e.githubTime>=? AND (? IS NULL OR e.githubTime<=?))) AND (e.version!=? OR d.taskId IS NOT ?) LIMIT 1",
      )
      .get(
        task.bindingId,
        p.number,
        time,
        upper,
        upper,
        targetKey,
        candidates.taskId!,
      );
    return conflict
      ? unknown("ambiguous_order")
      : {
          ...base,
          successorTaskId: String(candidates.taskId),
          reason: "matching_review_task",
        };
  }
  storeInput(task: Task, summary: ReviewInputSummary) {
    const p = this.pin(task);
    if (!p || !reference(p.r, summary.revision)) return;
    this.db
      .prepare(
        "INSERT INTO reviewInputs VALUES(?,?,?) ON CONFLICT(taskId) DO NOTHING",
      )
      .run(task.id, JSON.stringify(summary), Date.now());
  }
  input(id: string) {
    const row = this.db
      .prepare("SELECT summary,suppliedAt FROM reviewInputs WHERE taskId=?")
      .get(id);
    return row
      ? {
          ...(JSON.parse(String(row.summary)) as ReviewInputSummary),
          suppliedAt: Number(row.suppliedAt),
        }
      : null;
  }
  previous(task: Task) {
    const p = this.pin(task);
    if (!p || p.time === null) return null;
    const rows = this.db
      .prepare(
        "SELECT id,githubTime,target,publicationReceipt FROM tasks WHERE bindingId=? AND json_extract(target,'$.kind')='pull_request' AND json_extract(target,'$.number')=? AND json_extract(eventKey,'$[0]')='review' AND status='succeeded' AND deliveryStatus='sent' AND (githubTime IS NULL OR githubTime<=?) AND id!=? ORDER BY githubTime IS NULL DESC,githubTime DESC LIMIT 2",
      )
      .all(task.bindingId, p.number, p.time, task.id);
    const row = rows[0];
    if (
      !row ||
      typeof row.githubTime !== "number" ||
      row.githubTime === p.time ||
      row.githubTime === rows[1]?.githubTime ||
      this.separated(task, p.number, row.githubTime, p.time)
    )
      return null;
    const receipt = JSON.parse(String(row.publicationReceipt));
    const pin = revisionSchema.safeParse(
      JSON.parse(String(row.target)).revision,
    );
    if (
      !receipt ||
      !pin.success ||
      !Number.isSafeInteger(receipt.id) ||
      receipt.id < 1 ||
      !["comment", "review"].includes(receipt.kind) ||
      receipt.url !==
        `https://github.com/${task.owner}/${task.repo}/pull/${p.number}#${receipt.kind === "comment" ? "issuecomment-" : "pullrequestreview-"}${receipt.id}`
    )
      return null;
    return {
      taskId: String(row.id),
      revision: pin.data,
      publicationReceipt: {
        kind: String(receipt.kind),
        id: Number(receipt.id),
        url: String(receipt.url),
      },
      reviewInput: this.input(String(row.id)),
    };
  }
}
