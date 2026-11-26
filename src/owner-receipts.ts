import type { DatabaseSync } from "node:sqlite";
import type { RuntimeProfile } from "./runtime-profile.js";
import type { ActivityLedger } from "./activity-ledger.js";
import { profileParams, profilePredicate } from "./activity-ledger.js";

export interface ReceiptEntry {
  cursor: number;
  deliveryId: string;
}
export class ReceiptScopeDenied extends Error {}
export class ExpiredActivities extends Error {
  constructor(readonly expired: ReceiptEntry[]) {
    super("Activity details expired before confirmation");
  }
}
export type ReactionResult =
  | { status: "sent"; reactionId: number }
  | { status: "unknown"; reason: "unconfirmed" }
  | { status: "unknown"; reason: "lookup_rate_limited"; retryAt?: number }
  | {
      status: "failed";
      retryAt?: number;
      reason:
        | "unconfirmed"
        | "scope"
        | "forbidden"
        | "rate_limited"
        | "comment_unavailable"
        | "unavailable";
    };

const currentBinding =
  "(b.installationId||':'||b.repositoryId||':'||b.deviceId||':'||b.revision)";
/** Owned by TaskStore; callers wrap batch confirmations and reservations in an immediate transaction. */
export class OwnerReceipts {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ledger: ActivityLedger,
  ) {}
  confirm(
    device: string,
    profile: RuntimeProfile,
    binding: string,
    entries: ReceiptEntry[],
  ) {
    const scope = this.db
      .prepare(
        "SELECT repositoryId FROM bindings b WHERE b.deviceId=? AND " +
          currentBinding +
          "=? AND json_extract(b.declaration,'$.enabled')=1 AND " +
          profilePredicate,
      )
      .get(device, binding, ...profileParams(profile));
    if (
      !scope ||
      !entries.length ||
      entries.length > 25 ||
      new Set(entries.map((x) => x.cursor)).size !== entries.length
    )
      throw new ReceiptScopeDenied();
    const expired: ReceiptEntry[] = [];
    for (const entry of entries) {
      const d = this.db
        .prepare(
          "SELECT reason,taskId FROM deliveries WHERE deliveryId=? AND bindingId=? AND cursor=? AND eventKey IS NOT NULL",
        )
        .get(entry.deliveryId, binding, entry.cursor);
      if (!d) throw new ReceiptScopeDenied();
      if (
        this.db
          .prepare("SELECT 1 FROM ownerReceipts WHERE cursor=?")
          .get(entry.cursor)
      )
        continue;
      const a = this.ledger.activity(entry.cursor);
      if (!a) {
        expired.push(entry);
        continue;
      }
      if (
        a.deliveryId !== entry.deliveryId ||
        a.bindingId !== binding ||
        a.repositoryId !== scope.repositoryId
      )
        throw new ReceiptScopeDenied();
      const comment =
        a.source.event === "issue_comment" ? a.source.commentId : undefined;
      const eligible =
        a.reason === "mention" &&
        d.reason === "mention" &&
        a.taskId !== null &&
        a.taskId === d.taskId &&
        a.source.event === "issue_comment" &&
        a.source.action === "created" &&
        a.target.kind !== "repository" &&
        comment !== undefined &&
        !this.db
          .prepare(
            "SELECT 1 FROM ownerReceipts WHERE repositoryId=? AND commentId=? AND reactionStatus IS NOT NULL",
          )
          .get(a.repositoryId, comment);
      this.db
        .prepare(
          "INSERT INTO ownerReceipts(cursor,deliveryId,bindingId,deviceId,runtime,confirmedAt,repositoryId,commentId,taskId,reactionStatus) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          entry.cursor,
          entry.deliveryId,
          binding,
          device,
          JSON.stringify(profile),
          Date.now(),
          a.repositoryId,
          comment ?? null,
          eligible ? a.taskId : null,
          eligible ? "pending" : null,
        );
    }
    if (expired.length) throw new ExpiredActivities(expired);
  }
  get(deliveryId: string) {
    const r = this.db
      .prepare(
        "SELECT r.* FROM ownerReceipts r JOIN deliveries d ON d.cursor=r.cursor AND d.bindingId=r.bindingId WHERE d.deliveryId=?",
      )
      .get(deliveryId);
    return r ? this.decode(r) : null;
  }
  private decode(r: Record<string, unknown>) {
    return {
      deliveryId: String(r.deliveryId),
      cursor: Number(r.cursor),
      repositoryId: Number(r.repositoryId),
      commentId: r.commentId === null ? null : Number(r.commentId),
      bindingId: String(r.bindingId),
      deviceId: String(r.deviceId),
      runtime: JSON.parse(String(r.runtime)) as RuntimeProfile,
      confirmedAt: Number(r.confirmedAt),
      reaction:
        r.reactionStatus === null
          ? null
          : {
              status: String(r.reactionStatus),
              reason: r.reason === null ? null : String(r.reason),
              reactionId: r.reactionId === null ? null : Number(r.reactionId),
            },
    };
  }
  forComment(repositoryId: number, commentId: number) {
    return this.db
      .prepare(
        "SELECT * FROM ownerReceipts WHERE repositoryId=? AND commentId=? ORDER BY cursor DESC",
      )
      .all(repositoryId, commentId)
      .map((row) => this.decode(row));
  }
  allowed(taskId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM ownerReceipts r JOIN tasks t ON t.id=r.taskId JOIN bindings b ON b.repositoryId=t.repositoryId AND b.installationId=t.installationId LEFT JOIN threadClosures c ON c.repositoryId=t.repositoryId AND c.thread=json_extract(t.target,'$.kind')||':'||json_extract(t.target,'$.number') WHERE r.taskId=? AND r.bindingId=t.bindingId AND t.bindingId=" +
          currentBinding +
          " AND json_extract(b.declaration,'$.enabled')=1 AND t.publicationBlocked=0 AND (c.thread IS NULL OR t.githubTime>c.closedAt)",
      )
      .get(taskId);
  }
  reserve() {
    const r = this.db
      .prepare(
        "SELECT r.taskId FROM ownerReceipts r JOIN tasks t ON t.id=r.taskId LEFT JOIN reactionCooldowns c ON c.installationId=t.installationId WHERE r.reactionStatus='pending' AND (c.until IS NULL OR c.until<=?) ORDER BY r.cursor LIMIT 1",
      )
      .get(Date.now());
    if (!r) return;
    const id = String(r.taskId);
    if (!this.allowed(id)) {
      this.db
        .prepare(
          "UPDATE ownerReceipts SET reactionStatus='failed',reason='scope' WHERE taskId=?",
        )
        .run(id);
      return;
    }
    this.db
      .prepare(
        "UPDATE ownerReceipts SET reactionStatus='sending' WHERE taskId=?",
      )
      .run(id);
    return id;
  }
  finish(id: string, result: ReactionResult, reconcile = false) {
    if (
      result.status === "sent" &&
      (!Number.isSafeInteger(result.reactionId) || result.reactionId < 1)
    )
      throw Error("Invalid reaction identity");
    const changes = this.db
      .prepare(
        "UPDATE ownerReceipts SET reactionStatus=?,reason=?,reactionId=? WHERE taskId=? AND reactionStatus=?",
      )
      .run(
        result.status,
        result.status === "sent" ? null : result.reason,
        result.status === "sent" ? result.reactionId : null,
        id,
        reconcile ? "unknown" : "sending",
      );
    if (!changes.changes) throw Error("Reaction state changed");
    if (
      (result.status === "failed" && result.reason === "rate_limited") ||
      (result.status === "unknown" && result.reason === "lookup_rate_limited")
    ) {
      const until = Math.max(
        Date.now() + 60_000,
        Number.isSafeInteger(result.retryAt) ? result.retryAt! : 0,
      );
      this.db
        .prepare(
          "INSERT INTO reactionCooldowns(installationId,until) SELECT installationId,? FROM tasks WHERE id=? ON CONFLICT(installationId) DO UPDATE SET until=MAX(reactionCooldowns.until,excluded.until)",
        )
        .run(until, id);
    }
  }
  unknown(id: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM ownerReceipts WHERE taskId=? AND reactionStatus='unknown'",
      )
      .get(id);
  }
  lookupRetryAt(taskId: string) {
    const row = this.db
      .prepare(
        "SELECT c.until FROM reactionCooldowns c JOIN tasks t ON c.installationId=t.installationId WHERE t.id=? AND c.until>?",
      )
      .get(taskId, Date.now());
    return row ? Number(row.until) : null;
  }
}
