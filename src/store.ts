import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NewTask, Task, TaskState, DeliveryState } from "./contracts.js";

export class TaskStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, deliveryId TEXT NOT NULL UNIQUE, commentId INTEGER NOT NULL,
        bindingId TEXT NOT NULL, installationId INTEGER NOT NULL, repositoryId INTEGER NOT NULL,
        owner TEXT NOT NULL, repo TEXT NOT NULL, actorId INTEGER NOT NULL, actorLogin TEXT NOT NULL,
        issueNumber INTEGER NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','rejected','unknown')),
        deliveryStatus TEXT NOT NULL CHECK(deliveryStatus IN ('pending','sending','sent','failed','unknown')),
        result TEXT, error TEXT, createdAt INTEGER NOT NULL, responseId TEXT, commentUrl TEXT,
        UNIQUE(installationId, repositoryId, commentId));
      CREATE INDEX IF NOT EXISTS task_queue ON tasks(status,createdAt);
      CREATE INDEX IF NOT EXISTS task_binding ON tasks(bindingId,status);
      CREATE TABLE IF NOT EXISTS deliveries (deliveryId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id));`);
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
    return row ? ({ ...row } as unknown as Task) : undefined;
  }
  accept(input: NewTask): { task: Task; duplicate: boolean } {
    return this.transaction(() => {
      const delivery = this.db
        .prepare("SELECT taskId FROM deliveries WHERE deliveryId=?")
        .get(input.deliveryId);
      const existing = delivery
        ? this.get(delivery.taskId as string)
        : (this.db
            .prepare(
              "SELECT * FROM tasks WHERE deliveryId=? OR (installationId=? AND repositoryId=? AND commentId=?) ORDER BY CASE WHEN deliveryId=? THEN 0 ELSE 1 END LIMIT 1",
            )
            .get(
              input.deliveryId,
              input.installationId,
              input.repositoryId,
              input.commentId,
              input.deliveryId,
            ) as unknown as Task | undefined);
      if (existing) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO deliveries(deliveryId,taskId) VALUES (?,?)",
          )
          .run(input.deliveryId, existing.id);
        return { task: { ...existing }, duplicate: true };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO tasks (id, deliveryId, commentId, bindingId, installationId, repositoryId, owner, repo, actorId, actorLogin, issueNumber, prompt, status, deliveryStatus, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'queued','pending',?)`,
        )
        .run(
          id,
          input.deliveryId,
          input.commentId,
          input.bindingId,
          input.installationId,
          input.repositoryId,
          input.owner,
          input.repo,
          input.actorId,
          input.actorLogin,
          input.issueNumber,
          input.prompt,
          Date.now(),
        );
      this.db
        .prepare("INSERT INTO deliveries(deliveryId,taskId) VALUES (?,?)")
        .run(input.deliveryId, id);
      return { task: this.get(id)!, duplicate: false };
    });
  }
  claim(): Task | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id FROM tasks q WHERE q.status='queued' AND NOT EXISTS (
        SELECT 1 FROM tasks busy WHERE busy.bindingId=q.bindingId AND (
          busy.status IN ('running','unknown') OR
          (busy.status='succeeded' AND busy.deliveryStatus IN ('pending','sending','unknown'))
        )) ORDER BY q.createdAt,q.rowid LIMIT 1`,
        )
        .get();
      if (!row) return undefined;
      this.db
        .prepare("UPDATE tasks SET status='running' WHERE id=?")
        .run(row.id!);
      return this.get(row.id as string);
    });
  }
  finish(
    id: string,
    status: TaskState,
    result?: string,
    error?: string,
    responseId?: string,
  ): void {
    if (!["succeeded", "failed", "rejected", "unknown"].includes(status))
      throw new Error("Invalid task terminal state");
    if (
      status === "succeeded" &&
      (typeof result !== "string" || !result.trim())
    )
      throw new Error("Successful task requires a result");
    const changed = this.db
      .prepare(
        `UPDATE tasks SET status=?, result=?, error=?, responseId=? WHERE id=? AND status='running'`,
      )
      .run(status, result ?? null, error ?? null, responseId ?? null, id);
    if (!changed.changes) throw new Error("Task is not running");
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
  markDelivery(id: string, status: DeliveryState, url?: string): void {
    if (!["sent", "failed", "unknown"].includes(status))
      throw new Error("Invalid delivery transition");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET deliveryStatus=?, commentUrl=? WHERE id=? AND status='succeeded' AND deliveryStatus='sending'",
      )
      .run(status, url ?? null, id);
    if (!changed.changes) throw new Error("Delivery is not sending");
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
    url?: string,
  ): void {
    if (!["sent", "failed"].includes(terminal))
      throw new Error("Invalid delivery resolution");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET deliveryStatus=?, commentUrl=? WHERE id=? AND status='succeeded' AND deliveryStatus='unknown'",
      )
      .run(terminal, url ?? null, id);
    if (!changed.changes) throw new Error("Delivery is not unknown");
  }
  resolveUnknown(id: string, terminal: "failed" | "succeeded"): void {
    if (!["failed", "succeeded"].includes(terminal))
      throw new Error("Invalid resolution");
    const changed = this.db
      .prepare(
        "UPDATE tasks SET status=? WHERE id=? AND status='unknown' AND (?='failed' OR (result IS NOT NULL AND length(trim(result))>0))",
      )
      .run(terminal, id, terminal);
    if (!changed.changes)
      throw new Error("Task is not unknown or lacks a success result");
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
