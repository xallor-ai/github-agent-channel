import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  NewTask,
  Task,
  DeliveryState,
  PublicationReceipt,
  RuntimeResult,
  RuntimeEvent,
} from "./contracts.js";

import {
  failureCodes,
  failedExecutionMessage,
  notifiableFailures,
  noticeFailureCode,
  type RuntimeFailureCode,
} from "./runtime-failure.js";
import {
  ActivityLedger,
  threadKey,
  profileParams,
  profilePredicate,
} from "./activity-ledger.js";
import type { RuntimeProfile } from "./runtime-profile.js";
import type { WebhookDecision } from "./webhook.js";
import { BindingRegistry, effectiveEvents } from "./binding-registry.js";
import { initializeTaskSchema } from "./store-schema.js";
import { validateOutcome, validateTaskOutcome } from "./outcomes.js";

// Prior failed tasks also used pending. Only explicitly diagnosed model failures may enqueue a notice.
const publishableStatus =
  "(busy.status='succeeded' OR (busy.status='failed' AND busy.error IN (" +
  notifiableFailures.map(() => "?").join(",") +
  ")))";
const noticeMessages = notifiableFailures.map(failedExecutionMessage);
const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type AssignmentResult =
  | { status: "succeeded"; outcome: RuntimeResult }
  | { status: "failed" | "unknown"; failure?: RuntimeFailureCode };

/** Domain rejection only; infrastructure errors must remain retryable. */
export class AssignmentConflict extends Error {}

export class StaleBinding extends Error {}
export class InvalidAssignmentOutcome extends Error {}

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly ledger: ActivityLedger;
  readonly registry: BindingRegistry;
  private closed = false;
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      initializeTaskSchema(this.db);
      this.ledger = new ActivityLedger(this.db);
      this.registry = new BindingRegistry(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  activeBinding(installationId: number, repositoryId: number) {
    const record = this.registry.get({ installationId, repositoryId });
    if (!record?.enabled) return undefined;
    return {
      ...record,
      events: effectiveEvents(record),
      deepReview:
        record.deepReview === true &&
        record.responsibleAgent?.deepReview === true,
      nativeReview:
        record.nativeReview === true &&
        record.responsibleAgent?.nativeReview === true,
      id: `${installationId}:${repositoryId}:${record.deviceId}:${record.revision}`,
    };
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return row ? this.decodeTask(row) : undefined;
  }
  private decodeTask(row: Record<string, unknown>): Task {
    const {
      eventKey: _eventKey,
      publicationBlocked: _publicationBlocked,
      githubTime: _githubTime,
      ...data
    } = row;
    return {
      ...data,
      target: JSON.parse(String(row.target)),
      source: JSON.parse(String(row.source)),
      outcome: row.outcome === null ? null : JSON.parse(String(row.outcome)),
      runtime: row.runtime === null ? null : JSON.parse(String(row.runtime)),
      publicationReceipt:
        row.publicationReceipt === null
          ? null
          : JSON.parse(String(row.publicationReceipt)),
    } as unknown as Task;
  }
  accept(input: NewTask): { task: Task; duplicate: boolean } {
    // Direct task construction for trusted callers/tests. HTTP ingress only calls observe.
    const accepted = this.record(input, "mention", true);
    if (!accepted.taskId) throw Error("Existing observation has no task");
    return { task: this.get(accepted.taskId)!, duplicate: accepted.duplicate };
  }
  observe(decision: WebhookDecision) {
    if (decision.execute && decision.input.source.event === "push")
      throw Error("Push cannot execute");
    return this.record(
      decision.input,
      decision.reason,
      decision.execute,
      decision.githubTime,
    );
  }
  activityReceipt(deliveryId: string) {
    const receipt = this.ledger.receipt(deliveryId);
    return (
      receipt && {
        ...receipt,
        ...this.ledger.deliveryAttempts(deliveryId),
        deliveryId,
        activity: this.ledger.activity(receipt.cursor) ?? null,
      }
    );
  }
  recentThread(
    task: Pick<
      NewTask,
      "bindingId" | "installationId" | "repositoryId" | "deliveryId" | "target"
    >,
  ) {
    return this.activeBinding(task.installationId, task.repositoryId)?.id ===
      task.bindingId
      ? this.ledger.thread(task)
      : [];
  }
  activitiesForDevice(
    workerId: string,
    after: number,
    limit: number,
    profile: RuntimeProfile,
    bindingId: string,
  ) {
    return this.ledger.page(workerId, after, limit, profile, bindingId);
  }
  runtimeLastSeen(deviceId: string, profile: RuntimeProfile): number | null {
    const row = this.db
      .prepare(
        "SELECT seenAt FROM runtimePolls WHERE deviceId=? AND runtimeType=? AND runtimeId=? AND deepReview=? AND nativeReview=?",
      )
      .get(deviceId, ...profileParams(profile));
    return row ? Number(row.seenAt) : null;
  }
  recordRuntimePoll(deviceId: string, profile: RuntimeProfile) {
    const now = Date.now(),
      keys = profileParams(profile);
    // Ignore arbitrary self-declared profiles, and coalesce frequent healthy polls.
    // Binding updates remove the row immediately once the last matching binding changes.
    this.db
      .prepare(
        `INSERT INTO runtimePolls(deviceId,runtimeType,runtimeId,deepReview,nativeReview,seenAt)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM bindings b WHERE b.deviceId=? AND json_extract(b.declaration,'$.enabled')=1 AND ${profilePredicate})
      ON CONFLICT(deviceId,runtimeType,runtimeId,deepReview,nativeReview) DO UPDATE SET seenAt=excluded.seenAt WHERE runtimePolls.seenAt<=?`,
      )
      .run(deviceId, ...keys, now, deviceId, ...keys, now - 30_000);
  }
  private record(
    input: NewTask,
    reason: WebhookDecision["reason"],
    execute: boolean,
    githubTime?: number,
  ) {
    return this.transaction(() => {
      const binding = this.activeBinding(
        input.installationId,
        input.repositoryId,
      );
      const sourceKey =
        input.source.event === "push"
          ? "push"
          : `${input.source.event}.${input.source.action}`;
      if (
        !binding ||
        binding.id !== input.bindingId ||
        binding.owner !== input.owner ||
        binding.repo !== input.repo ||
        !binding.events.some((event) => event === sourceKey)
      )
        throw new StaleBinding("Binding changed before acceptance");
      const scope = [input.repositoryId, threadKey(input.target)];
      const closed = execute
        ? this.db
            .prepare(
              "SELECT closedAt FROM threadClosures WHERE repositoryId=? AND thread=?",
            )
            .get(...scope)
        : undefined;
      const isStale =
        closed &&
        (closed.closedAt === null ||
          githubTime === undefined ||
          githubTime <= Number(closed.closedAt));
      const receipt = this.ledger.record(
        input,
        isStale ? "closed" : reason,
        execute && !isStale
          ? (eventKey) => {
              const id = randomUUID();
              this.db
                .prepare(
                  `INSERT INTO tasks(id,deliveryId,eventKey,bindingId,installationId,repositoryId,owner,repo,actorId,actorLogin,prompt,status,deliveryStatus,createdAt,target,source,githubTime) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued','pending',?,?,?,?)`,
                )
                .run(
                  id,
                  input.deliveryId,
                  eventKey,
                  input.bindingId,
                  input.installationId,
                  input.repositoryId,
                  input.owner,
                  input.repo,
                  input.actorId,
                  input.actorLogin,
                  input.prompt,
                  Date.now(),
                  JSON.stringify(input.target),
                  JSON.stringify(input.source),
                  githubTime ?? null,
                );
              return id;
            }
          : undefined,
        closed?.closedAt == null ? undefined : Number(closed.closedAt),
      );
      if (
        !receipt.duplicate &&
        reason === "closed" &&
        input.target.kind !== "repository"
      ) {
        // A missing close instant cannot be ordered relative to any later delivery.
        // Preserve that uncertainty rather than guessing from arrival order.
        this.db
          .prepare(
            `INSERT INTO threadClosures VALUES(?,?,?) ON CONFLICT(repositoryId,thread) DO UPDATE SET closedAt=max(threadClosures.closedAt,excluded.closedAt)`,
          )
          .run(...scope, githubTime ?? null);
        const affected = [
          input.repositoryId,
          input.target.kind,
          input.target.number,
          githubTime ?? null,
          githubTime ?? null,
        ];
        const target =
          "repositoryId=? AND json_extract(target,'$.kind')=? AND json_extract(target,'$.number')=? AND (? IS NULL OR githubTime IS NULL OR githubTime<=?)";
        this.db
          .prepare(
            "UPDATE tasks SET publicationBlocked=1 WHERE deliveryStatus IN ('sending','pending') AND " +
              target,
          )
          .run(...affected);
        this.db
          .prepare(
            "UPDATE tasks SET status='rejected',deliveryStatus='skipped',error='Thread closed before execution' WHERE status='queued' AND " +
              target,
          )
          .run(...affected);
        this.db
          .prepare(
            "UPDATE tasks SET status='unknown',error='Thread closed during execution; reconcile' WHERE status='running' AND " +
              target,
          )
          .run(...affected);
        this.db
          .prepare(
            "UPDATE tasks SET deliveryStatus='skipped',error='Thread closed before publication' WHERE status IN ('succeeded','failed') AND deliveryStatus='pending' AND " +
              target,
          )
          .run(...affected);
      }
      return receipt;
    });
  }
  recordRuntime(id: string, event: RuntimeEvent): void {
    const task = this.get(id);
    if (
      !task ||
      task.status !== "running" ||
      (task.runtime && JSON.stringify(task.runtime) !== JSON.stringify(event))
    )
      throw new AssignmentConflict("Runtime handle conflicts");
    this.db
      .prepare("UPDATE tasks SET runtime=? WHERE id=? AND status='running'")
      .run(JSON.stringify(event), id);
  }
  expireTasks(now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE tasks SET status='rejected', deliveryStatus='skipped', error='Queue deadline expired before execution'
      WHERE status='queued' AND createdAt<=?`,
      )
      .run(now - QUEUE_MAX_AGE_MS);
    this.db
      .prepare(
        `UPDATE tasks SET status='unknown', error='Connector lease expired; reconcile execution'
      WHERE status='running' AND id IN (SELECT taskId FROM assignments WHERE expiresAt<=?)`,
      )
      .run(now);
  }
  claimAssignment(
    workerId: string,
    leaseHash: string,
    expiresAt: number,
    now = Date.now(),
    profile?: RuntimeProfile,
  ): Task | undefined {
    if (
      !workerId ||
      !leaseHash ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    )
      throw new Error("Invalid assignment");
    return this.transaction(() => {
      this.expireTasks(now);
      const busy = this.db
        .prepare(
          `SELECT 1 FROM assignments a JOIN tasks t ON t.id=a.taskId
        WHERE a.workerId=? AND t.status IN ('running','unknown') LIMIT 1`,
        )
        .get(workerId);
      if (busy) return undefined;
      const row = this.db
        .prepare(
          `SELECT q.id FROM tasks q JOIN bindings b USING (installationId,repositoryId) WHERE q.status='queued' AND b.deviceId=? ${profile ? "AND " + profilePredicate : ""} AND NOT EXISTS (
        SELECT 1 FROM tasks busy WHERE busy.installationId=q.installationId AND busy.repositoryId=q.repositoryId AND (
          busy.status IN ('running','unknown') OR (${publishableStatus} AND busy.deliveryStatus IN ('pending','sending','unknown'))
        )) ORDER BY q.createdAt,q.rowid LIMIT 1`,
        )
        .get(
          workerId,
          ...(profile ? profileParams(profile) : []),
          ...noticeMessages,
        );
      if (!row) return undefined;
      this.db
        .prepare(
          "UPDATE tasks SET status='running' WHERE id=? AND status='queued'",
        )
        .run(row.id!);
      this.db
        .prepare(
          "INSERT INTO assignments(taskId,workerId,leaseHash,expiresAt) VALUES (?,?,?,?)",
        )
        .run(row.id!, workerId, leaseHash, expiresAt);
      return this.get(row.id as string);
    });
  }
  assignedTask(
    taskId: string,
    workerId: string,
    leaseHash: string,
    now = Date.now(),
  ): Task | undefined {
    this.expireTasks(now);
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN assignments a ON a.taskId=t.id
      WHERE t.id=? AND a.workerId=? AND a.leaseHash=? AND a.expiresAt>? AND t.status='running'`,
      )
      .get(taskId, workerId, leaseHash, now);
    return row ? this.decodeTask(row) : undefined;
  }
  pinPullRevision(
    id: string,
    workerId: string,
    leaseHash: string,
    revision: import("./contracts.js").PullRevision,
  ): Task {
    return this.transaction(() => {
      const task = this.assignedTask(id, workerId, leaseHash);
      if (
        !task ||
        task.target.kind !== "pull_request" ||
        this.activeBinding(task.installationId, task.repositoryId)?.id !==
          task.bindingId
      )
        throw new AssignmentConflict("PR claim no longer active");
      if (
        task.target.revision ||
        task.source.event !== "issue_comment" ||
        revision.baseRepoId !== task.repositoryId ||
        revision.headRepoId !== task.repositoryId
      )
        throw new AssignmentConflict("Cannot resolve this revision");
      const target = { ...task.target, revision };
      this.db
        .prepare("UPDATE tasks SET target=? WHERE id=? AND status='running'")
        .run(JSON.stringify(target), id);
      return { ...task, target };
    });
  }
  finishAssignment(
    taskId: string,
    workerId: string,
    leaseHash: string,
    result: AssignmentResult,
    digest: string,
    now = Date.now(),
  ): boolean {
    // Commit expiry independently: a rejected late result must not roll it back.
    this.expireTasks(now);
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM assignments WHERE taskId=? AND workerId=? AND leaseHash=?",
        )
        .get(taskId, workerId, leaseHash);
      if (!row) throw new AssignmentConflict("Assignment not found");
      const task = this.get(taskId)!;
      if (
        this.activeBinding(task.installationId, task.repositoryId)?.id !==
        task.bindingId
      )
        throw new AssignmentConflict("Binding revision changed");
      if (row.resultDigest !== null) {
        if (row.resultDigest === digest) return true;
        throw new AssignmentConflict("Conflicting assignment result");
      }
      if (Number(row.expiresAt) <= now || task.status !== "running")
        throw new AssignmentConflict("Assignment is not active");
      if (
        !["succeeded", "failed", "unknown"].includes(result.status) ||
        Object.keys(result).some(
          (key) =>
            key !== "status" &&
            !(
              result.status !== "succeeded" &&
              key === "failure" &&
              failureCodes[result.status].safeParse(result.failure).success
            ) &&
            !(result.status === "succeeded" && key === "outcome"),
        )
      )
        throw new AssignmentConflict("Invalid assignment result");
      let outcome: RuntimeResult | undefined;
      if (result.status === "succeeded") {
        try {
          outcome = validateOutcome(result.outcome);
          validateTaskOutcome(task, outcome);
        } catch {
          throw new InvalidAssignmentOutcome("Invalid assignment outcome");
        }
      }
      this.db
        .prepare(
          "UPDATE tasks SET status=?,outcome=?,error=?,deliveryStatus=? WHERE id=? AND status='running'",
        )
        .run(
          result.status,
          outcome ? JSON.stringify(outcome) : null,
          result.status === "unknown"
            ? `Connector execution requires reconciliation${result.failure ? ` (${result.failure})` : ""}`
            : result.status === "failed"
              ? result.failure
                ? failedExecutionMessage(result.failure)
                : "Connector execution failed"
              : null,
          result.status === "succeeded"
            ? outcome?.publication.kind === "none"
              ? "skipped"
              : "pending"
            : result.status === "failed" &&
                task.target.kind !== "repository" &&
                result.failure &&
                noticeFailureCode(failedExecutionMessage(result.failure))
              ? "pending"
              : "skipped",
          taskId,
        );
      this.db
        .prepare("UPDATE assignments SET resultDigest=? WHERE taskId=?")
        .run(digest, taskId);
      return false;
    });
  }
  rejectUndeliveredClaim(
    id: string,
    workerId: string,
    leaseHash: string,
    status: "rejected" | "failed",
    error: string,
  ): void {
    if (!["rejected", "failed"].includes(status) || !error)
      throw Error("Invalid assignment rejection");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET status=?,deliveryStatus='skipped',error=? WHERE id=? AND runtime IS NULL AND status IN ('running','unknown') AND EXISTS (SELECT 1 FROM assignments WHERE taskId=tasks.id AND workerId=? AND leaseHash=?)",
      )
      .run(status, error, id, workerId, leaseHash);
    if (!changed.changes) throw new AssignmentConflict("Task is not running");
  }
  publicationAllowed(taskId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM tasks WHERE id=? AND publicationBlocked=0")
      .get(taskId);
  }
  pendingDelivery(): Task | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id FROM tasks busy WHERE ${publishableStatus} AND deliveryStatus='pending' ORDER BY createdAt,rowid LIMIT 1`,
        )
        .get(...noticeMessages);
      if (!row) return undefined;
      this.db
        .prepare("UPDATE tasks SET deliveryStatus='sending' WHERE id=?")
        .run(row.id!);
      return this.get(row.id as string);
    });
  }
  markDelivery(
    id: string,
    status: DeliveryState,
    receipt?: PublicationReceipt,
  ): void {
    if (!["sent", "failed", "unknown"].includes(status))
      throw Error("Invalid delivery transition");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET deliveryStatus=?,publicationReceipt=? WHERE id=? AND status IN ('succeeded','failed') AND deliveryStatus='sending'",
      )
      .run(status, receipt ? JSON.stringify(receipt) : null, id);
    if (!changed.changes) throw Error("Delivery is not sending");
  }
  recover(): void {
    this.transaction(() => {
      this.db.exec(
        "UPDATE tasks SET status='unknown' WHERE status='running'; UPDATE tasks SET deliveryStatus='unknown' WHERE deliveryStatus='sending';",
      );
    });
  }
  resolveUnknownDelivery(
    id: string,
    terminal: "sent" | "failed",
    receipt?: PublicationReceipt,
  ): void {
    if (!["sent", "failed"].includes(terminal))
      throw Error("Invalid delivery resolution");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET deliveryStatus=?,publicationReceipt=? WHERE id=? AND status IN ('succeeded','failed') AND deliveryStatus='unknown'",
      )
      .run(terminal, receipt ? JSON.stringify(receipt) : null, id);
    if (!changed.changes) throw Error("Delivery is not unknown");
  }
  resolveUnknown(id: string, terminal: "failed"): void {
    if (terminal !== "failed") throw new Error("Invalid resolution");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET status='failed',deliveryStatus='skipped' WHERE id=? AND status='unknown'",
      )
      .run(id);
    if (!changed.changes) throw new Error("Task is not unknown");
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
