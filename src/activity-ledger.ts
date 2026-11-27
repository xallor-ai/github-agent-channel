import type { DatabaseSync } from "node:sqlite";
import type { NewTask } from "./contracts.js";
import type { RuntimeProfile } from "./runtime-profile.js";
import type { WebhookDecision } from "./webhook.js";
import { admitReview } from "./review-generation.js";
import { reviewKey } from "./review-lineage.js";

const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_REPOSITORY = 1024;
const EXCERPT = 1024;
export const profilePredicate = `json_extract(b.declaration,'$.responsibleAgent.type')=? AND json_extract(b.declaration,'$.responsibleAgent.id')=?
 AND json_extract(b.declaration,'$.responsibleAgent.deepReview')=? AND json_extract(b.declaration,'$.responsibleAgent.nativeReview')=?`;
export const profileParams = (p: RuntimeProfile) => [
  p.type,
  p.id,
  Number(p.deepReview),
  Number(p.nativeReview),
];
const currentBinding = `b.installationId||':'||b.repositoryId||':'||b.deviceId||':'||b.revision`;
export const threadKey = (t: NewTask["target"]) =>
  t.kind === "repository" ? "repository" : t.kind + ":" + t.number;
type Reason = WebhookDecision["reason"];
type Receipt = {
  cursor: number;
  taskId: string | null;
  reason: Reason;
  bindingId: string;
};
type Activity = Omit<NewTask, "prompt" | "actorId"> & {
  cursor: number;
  receivedAt: number;
  reason: Reason;
  taskId: string | null;
  excerpt: string;
  truncated: boolean;
};

/** All writes run inside the caller's task transaction. Only small decision receipts outlive the bounded activity data. */
export class ActivityLedger {
  constructor(private readonly db: DatabaseSync) {}

  receipt(deliveryId: string): Receipt | undefined {
    return this.db
      .prepare(
        "SELECT cursor,taskId,reason,bindingId FROM deliveries WHERE deliveryId=?",
      )
      .get(deliveryId) as Receipt | undefined;
  }
  deliveryAttempts(deliveryId: string) {
    const row = this.db
      .prepare(
        "SELECT attempts, duplicate,reviewFollowUp FROM deliveries WHERE deliveryId=?",
      )
      .get(deliveryId);
    return (
      row && {
        attempts: Number(row.attempts),
        duplicate: row.duplicate === 1,
        ...(row.reviewFollowUp
          ? { reviewFollowUp: String(row.reviewFollowUp) }
          : {}),
      }
    );
  }

  record(
    input: NewTask,
    reason: Reason,
    createTask?: (
      key: string,
      input?: NewTask,
      time?: number,
      receivedAt?: number,
    ) => string,
    closedAt?: number,
    githubTime?: number,
  ) {
    const key =
      input.source.event === "issue_comment" &&
      input.source.commentId !== undefined
        ? JSON.stringify([
            "comment",
            input.installationId,
            input.repositoryId,
            input.source.commentId,
          ])
        : JSON.stringify(["delivery", input.deliveryId]);
    const original =
      this.receipt(input.deliveryId) ??
      (this.db
        .prepare(
          "SELECT cursor,taskId,reason,bindingId FROM deliveries WHERE eventKey=?",
        )
        .get(key) as Receipt | undefined);
    if (original) {
      this.db
        .prepare(
          "INSERT INTO deliveries VALUES(?,NULL,?,?,?,?,1,1,NULL,NULL) ON CONFLICT(deliveryId) DO UPDATE SET attempts=attempts+1",
        )
        .run(
          input.deliveryId,
          original.bindingId,
          original.cursor,
          original.taskId,
          original.reason,
        );
      return { ...original, duplicate: true };
    }
    const target = input.target;
    const taskKey =
      reason === "review" && target.kind === "pull_request" && target.revision
        ? reviewKey(
            input.installationId,
            input.repositoryId,
            target.number,
            target.revision,
          )
        : key;
    let priorTask = createTask
      ? this.db
          .prepare(
            `SELECT id,bindingId,status,githubTime FROM tasks WHERE eventKey=?
          AND (bindingId=? OR status!='rejected' OR EXISTS(SELECT 1 FROM assignments WHERE taskId=tasks.id))
          AND (? IS NULL OR githubTime>?) ORDER BY (bindingId=?) DESC, (githubTime<=?) DESC, CASE WHEN githubTime<=? THEN githubTime END DESC, rowid DESC LIMIT 1`,
          )
          .get(
            taskKey,
            input.bindingId,
            closedAt ?? null,
            closedAt ?? null,
            input.bindingId,
            githubTime ?? null,
            githubTime ?? null,
          )
      : undefined;
    const receivedAt = Date.now();
    const decision =
      reason === "review" &&
      createTask &&
      target.kind === "pull_request" &&
      target.revision
        ? admitReview(
            this.db,
            input,
            taskKey,
            githubTime,
            closedAt,
            priorTask as
              | {
                  id: string;
                  bindingId: string;
                  status: string;
                  githubTime: number | null;
                }
              | undefined,
            createTask,
          )
        : null;
    const unconfirmedGeneration = decision?.unconfirmed ?? false;
    const reused = decision?.reused ?? !!priorTask;
    const taskId = decision
      ? decision.taskId
      : priorTask
        ? String(priorTask.id)
        : (createTask?.(taskKey) ?? null);
    if (decision && (taskId !== priorTask?.id || !reused))
      priorTask = undefined;
    if (
      !unconfirmedGeneration &&
      priorTask?.status === "queued" &&
      priorTask.bindingId === input.bindingId &&
      reason === "review" &&
      githubTime !== undefined
    ) {
      // A later close can separate two previously coalesced same-version reviews.
      // Keep only the newest candidate and discard its body as soon as dispatch is reserved.
      this.db
        .prepare(
          `INSERT INTO reviewCandidates VALUES(?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET githubTime=excluded.githubTime,receivedAt=excluded.receivedAt,input=excluded.input WHERE excluded.githubTime>reviewCandidates.githubTime`,
        )
        .run(priorTask.id!, githubTime, receivedAt, JSON.stringify(input));
    }
    const { prompt, actorId: _actorId, ...scope } = input;
    const data = {
      ...scope,
      reason,
      // Receipts are an admin surface. A new responsible agent must not receive an old binding's task identity.
      taskId:
        priorTask && priorTask.bindingId !== input.bindingId ? null : taskId,
      excerpt: prompt.slice(0, EXCERPT),
      truncated: prompt.length > EXCERPT,
      receivedAt,
    };
    const cursor = Number(
      this.db
        .prepare(
          "INSERT INTO activities(deliveryId,installationId,repositoryId,bindingId,thread,receivedAt,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          input.deliveryId,
          input.installationId,
          input.repositoryId,
          input.bindingId,
          threadKey(input.target),
          receivedAt,
          JSON.stringify(data),
        ).lastInsertRowid,
    );
    this.db
      .prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?,1,?,?,?)")
      .run(
        input.deliveryId,
        key,
        input.bindingId,
        cursor,
        taskId,
        reason,
        Number(reused),
        githubTime ?? null,
        unconfirmedGeneration
          ? "review_generation_unconfirmed"
          : priorTask && priorTask.bindingId !== input.bindingId
            ? "check_prior_review_before_delegating"
            : null,
      );
    this.db
      .prepare("DELETE FROM activities WHERE receivedAt<=?")
      .run(receivedAt - MAX_AGE);
    this.db
      .prepare(
        `DELETE FROM activities WHERE installationId=? AND repositoryId=? AND cursor<=(
      SELECT cursor FROM activities WHERE installationId=? AND repositoryId=? ORDER BY cursor DESC LIMIT 1 OFFSET ?)`,
      )
      .run(
        input.installationId,
        input.repositoryId,
        input.installationId,
        input.repositoryId,
        MAX_PER_REPOSITORY,
      );
    return {
      cursor,
      taskId,
      reason,
      bindingId: input.bindingId,
      duplicate: reused,
    };
  }

  // Use the individual close instant, even if a later close was delivered first.
  // This repairs attribution only; the representative and its lease are untouched.
  detachPreCloseReviews(
    repositoryId: number,
    number: number,
    closedAt: number,
    latestClosedAt: number | null,
  ) {
    const representative =
      "SELECT id FROM tasks WHERE repositoryId=? AND json_extract(target,'$.kind')='pull_request' AND json_extract(target,'$.number')=?";
    const stale = `duplicate=1 AND reason='review' AND (
      ((githubTime IS NULL OR githubTime<=?) AND taskId IN (${representative} AND githubTime>?))
      OR (githubTime>? AND githubTime<=? AND taskId IN (${representative} AND (githubTime IS NULL OR githubTime<=?))))`;
    const scope = [
      closedAt,
      repositoryId,
      number,
      closedAt,
      closedAt,
      latestClosedAt,
      repositoryId,
      number,
      closedAt,
    ];
    this.db
      .prepare(
        `UPDATE activities SET data=json_set(data,'$.taskId',NULL,'$.reason','closed')
      WHERE cursor IN (SELECT cursor FROM deliveries WHERE ${stale})`,
      )
      .run(...scope);
    this.db
      .prepare(
        `UPDATE deliveries SET taskId=NULL,reason='closed',reviewFollowUp=NULL,duplicate=0
      WHERE ${stale}`,
      )
      .run(...scope);
  }

  private decode(row: Record<string, unknown>): Activity {
    return { ...JSON.parse(String(row.data)), cursor: Number(row.cursor) };
  }
  activity(cursor: number) {
    const row = this.db
      .prepare(
        "SELECT cursor,data FROM activities WHERE cursor=? AND receivedAt>?",
      )
      .get(cursor, Date.now() - MAX_AGE);
    return row ? this.decode(row) : undefined;
  }
  thread(task: Pick<NewTask, "bindingId" | "target" | "deliveryId">) {
    return this.db
      .prepare(
        `SELECT cursor,data FROM activities WHERE bindingId=? AND thread=? AND (? IS NULL OR cursor<(SELECT cursor FROM deliveries WHERE deliveryId=?)) AND receivedAt>? ORDER BY cursor DESC LIMIT 8`,
      )
      .all(
        task.bindingId,
        threadKey(task.target),
        task.deliveryId || null,
        task.deliveryId,
        Date.now() - MAX_AGE,
      )
      .reverse()
      .map((r) => this.decode(r));
  }
  page(
    deviceId: string,
    after: number,
    limit: number,
    profile: RuntimeProfile,
    bindingId: string,
  ) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Error("Invalid activity cursor or limit");
    const cutoff = Date.now() - MAX_AGE;
    const filter = `(${currentBinding})=? AND b.deviceId=? AND json_extract(b.declaration,'$.enabled')=1 AND ${profilePredicate}`;
    const bindings = [bindingId, deviceId, ...profileParams(profile)];
    const records = this.db
      .prepare(
        `SELECT a.cursor,a.data FROM activities a JOIN bindings b USING(installationId,repositoryId)
       WHERE a.bindingId=(${currentBinding}) AND ${filter} AND a.cursor>? AND a.receivedAt>? ORDER BY a.cursor LIMIT ?`,
      )
      .all(...bindings, after, cutoff, limit + 1);
    const activities = records.slice(0, limit).map((r) => this.decode(r));
    const gap = this.db
      .prepare(
        `SELECT MAX(d.cursor) AS cursor FROM bindings b JOIN deliveries d ON d.bindingId=(${currentBinding})
       LEFT JOIN activities a ON a.cursor=d.cursor WHERE ${filter} AND d.cursor>? AND (a.cursor IS NULL OR a.receivedAt<=?)`,
      )
      .get(...bindings, after, cutoff);
    // If every visible item has expired, advance past the purged receipts. A retained item from another repository must never be skipped.
    return {
      activities,
      nextCursor:
        records.length > limit
          ? activities.at(-1)!.cursor
          : Math.max(
              activities.at(-1)?.cursor ?? after,
              Number(gap?.cursor ?? 0),
            ),
      hasMore: records.length > limit,
      truncated: gap?.cursor != null,
    };
  }
}
