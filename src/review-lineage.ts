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
  via: string,
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
      .prepare("SELECT githubTime FROM tasks WHERE id=? AND eventKey=?")
      .get(task.id, key);
    if (!row) return;
    return {
      r: pin.data,
      number: task.target.number,
      time: typeof row.githubTime === "number" ? row.githubTime : null,
      key,
    };
  }
  record(task: Task, observed: PullRevision) {
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
        "INSERT INTO reviewDrifts VALUES(?,?,?) ON CONFLICT(taskId) DO NOTHING",
      )
      .run(task.id, JSON.stringify(v.data), Date.now());
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
      .prepare(
        "SELECT g.*,t.target FROM reviewGenerations g JOIN tasks t ON t.id=g.via WHERE oldTaskId=?",
      )
      .get(task.id);
    const generation =
      witness &&
      p.time !== null &&
      !this.separated(task, p.number, p.time, Number(witness.returnedAt))
        ? {
            source: "signed_review_events",
            intermediateTaskId: String(witness.via),
            intermediateRevision: revisionSchema.parse(
              JSON.parse(String(witness.target)).revision,
            ),
            returnedAt: Number(witness.returnedAt),
            successorTaskId:
              witness.successor === null ? null : String(witness.successor),
          }
        : null;
    if (!row)
      return witness
        ? {
            previousRevision: p.r,
            observedRevision: null,
            observedAt: null,
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
    const upper = observedAt;
    const candidates = this.db
      .prepare(
        "SELECT id,githubTime FROM tasks WHERE bindingId=? AND eventKey=? AND (githubTime IS NULL OR githubTime BETWEEN ? AND ?) LIMIT 2",
      )
      .all(
        task.bindingId,
        reviewKey(
          task.installationId,
          task.repositoryId,
          p.number,
          observedRevision,
        ),
        p.time,
        upper,
      );
    if (!candidates.length) return unknown("no_matching_task");
    if (
      candidates.length !== 1 ||
      typeof candidates[0].githubTime !== "number" ||
      candidates[0].githubTime <= p.time
    )
      return unknown("ambiguous_order");
    const c = candidates[0];
    if (this.separated(task, p.number, p.time, upper))
      return unknown("lifecycle_uncertain");
    const competing = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE bindingId=? AND json_extract(target,'$.kind')='pull_request' AND json_extract(target,'$.number')=? AND json_extract(source,'$.event')='pull_request' AND json_extract(eventKey,'$[0]')='review' AND eventKey!=? AND (githubTime IS NULL OR githubTime BETWEEN ? AND ?) LIMIT 1",
      )
      .get(
        task.bindingId,
        p.number,
        reviewKey(
          task.installationId,
          task.repositoryId,
          p.number,
          observedRevision,
        ),
        c.githubTime!,
        upper,
      );
    return competing
      ? unknown("ambiguous_order")
      : {
          ...base,
          successorTaskId: String(c.id),
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
        "SELECT id,githubTime,target,publicationReceipt FROM tasks WHERE bindingId=? AND json_extract(target,'$.kind')='pull_request' AND json_extract(target,'$.number')=? AND json_extract(eventKey,'$[0]')='review' AND status='succeeded' AND deliveryStatus='sent' AND githubTime<=? AND id!=? ORDER BY githubTime DESC LIMIT 2",
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
