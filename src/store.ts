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

import { BindingRegistry } from "./binding-registry.js";
import { initializeTaskSchema } from "./store-schema.js";
import { validateOutcome, validateTaskOutcome } from "./outcomes.js";

const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type AssignmentResult =
  | { status: "succeeded"; outcome: RuntimeResult }
  | { status: "failed" | "unknown"; failure?: string; detail?: string };

/** Domain rejection only; infrastructure errors must remain retryable. */
export class AssignmentConflict extends Error {}

export class StaleBinding extends Error {}
export class InvalidAssignmentOutcome extends Error {}

export class TaskStore {
  private readonly db: DatabaseSync;
  readonly registry: BindingRegistry;
  private closed = false;
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      initializeTaskSchema(this.db);
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
    const { eventKey: _eventKey, ...data } = row;
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
      const eventKey =
        input.source.event === "issue_comment" &&
        input.source.commentId !== undefined
          ? JSON.stringify([
              "comment",
              input.installationId,
              input.repositoryId,
              input.source.commentId,
            ])
          : JSON.stringify(["delivery", input.deliveryId]);
      const delivery = this.db
        .prepare("SELECT taskId FROM deliveries WHERE deliveryId=?")
        .get(input.deliveryId);
      const existing = delivery
        ? this.get(String(delivery.taskId))
        : this.db
            .prepare("SELECT id FROM tasks WHERE eventKey=?")
            .get(eventKey);
      if (existing) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO deliveries(deliveryId,taskId) VALUES(?,?)",
          )
          .run(input.deliveryId, existing.id);
        return { task: this.get(String(existing.id))!, duplicate: true };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO tasks(id,deliveryId,eventKey,bindingId,installationId,repositoryId,owner,repo,actorId,actorLogin,prompt,status,deliveryStatus,createdAt,target,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued','pending',?,?,?)`,
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
        );
      this.db
        .prepare("INSERT INTO deliveries(deliveryId,taskId) VALUES(?,?)")
        .run(input.deliveryId, id);
      return { task: this.get(id)!, duplicate: false };
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
          `SELECT q.id FROM tasks q JOIN bindings b USING (installationId,repositoryId) WHERE q.status='queued' AND b.deviceId=? AND NOT EXISTS (
        SELECT 1 FROM tasks busy WHERE busy.installationId=q.installationId AND busy.repositoryId=q.repositoryId AND (
          busy.status IN ('running','unknown') OR (busy.status='succeeded' AND busy.deliveryStatus IN ('pending','sending','unknown'))
        )) ORDER BY q.createdAt,q.rowid LIMIT 1`,
        )
        .get(workerId);
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
              ? `Connector execution requires reconciliation${result.failure ? ` (${result.failure})` : ""}${result.detail ? `: ${result.detail}` : ""}`
            : result.status === "failed"
              ? `Connector execution failed${result.failure ? ` (${result.failure})` : ""}${result.detail ? `: ${result.detail}` : ""}`
              : null,
          outcome?.publication.kind === "none" ? "skipped" : "pending",
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
  pendingDelivery(): Task | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT id FROM tasks WHERE status='succeeded' AND deliveryStatus='pending' ORDER BY createdAt,rowid LIMIT 1",
        )
        .get();
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
        "UPDATE tasks SET deliveryStatus=?,publicationReceipt=? WHERE id=? AND status='succeeded' AND deliveryStatus='sending'",
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
        "UPDATE tasks SET deliveryStatus=?,publicationReceipt=? WHERE id=? AND status='succeeded' AND deliveryStatus='unknown'",
      )
      .run(terminal, receipt ? JSON.stringify(receipt) : null, id);
    if (!changed.changes) throw Error("Delivery is not unknown");
  }
  resolveUnknown(id: string, terminal: "failed"): void {
    if (terminal !== "failed") throw new Error("Invalid resolution");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET status='failed' WHERE id=? AND status='unknown'",
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
