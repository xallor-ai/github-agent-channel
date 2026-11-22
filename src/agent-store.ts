import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./contracts.js";

export interface Assignment {
  task: Task;
  leaseToken: string;
  expiresAt: number;
}
export interface AgentResult {
  leaseToken: string;
  status: "succeeded" | "failed" | "unknown";
  text?: string;
  responseId?: string;
}
export interface JournalEntry {
  id: string;
  assignment: string;
  result: string | null;
  phase: string;
}

export class AgentStore {
  private db!: DatabaseSync;
  private lock: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // A separate SQLite connection holds an OS-backed exclusive file lock.
    // Unlike a PID marker it survives namespace differences and releases on crash.
    this.lock = new DatabaseSync(
      path === ":memory:" ? ":memory:" : path + ".lock",
    );
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;",
      );
      if (path !== ":memory:") chmodSync(path + ".lock", 0o600);
    } catch {
      this.lock.close();
      throw Error("Agent state is already running or its lock is unavailable");
    }
    try {
      this.db = new DatabaseSync(path);
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, assignment TEXT NOT NULL, result TEXT, phase TEXT NOT NULL);`);
      this.transaction(() => {
        const running = this.db
          .prepare("SELECT id,assignment FROM journal WHERE phase='running'")
          .all() as unknown as JournalEntry[];
        for (const entry of running) {
          const assignment = JSON.parse(entry.assignment) as Assignment;
          this.db
            .prepare("UPDATE journal SET phase='pending',result=? WHERE id=?")
            .run(
              JSON.stringify({
                leaseToken: assignment.leaseToken,
                status: "unknown",
              }),
              entry.id,
            );
        }
      });
    } catch (e) {
      this.db?.close();
      this.lock.close();
      throw e;
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  begin(assignment: Assignment): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO journal(id,assignment,phase) VALUES(?,?,'running')",
        )
        .run(assignment.task.id, JSON.stringify(assignment));
      return result.changes === 1;
    });
  }
  finish(id: string, result: AgentResult): void {
    const changed = this.db
      .prepare(
        "UPDATE journal SET phase='pending', result=? WHERE id=? AND phase='running'",
      )
      .run(JSON.stringify(result), id);
    if (changed.changes !== 1) throw Error("Agent journal transition rejected");
  }
  pending(): JournalEntry | undefined {
    return this.db
      .prepare(
        "SELECT * FROM journal WHERE phase='pending' ORDER BY rowid LIMIT 1",
      )
      .get() as JournalEntry | undefined;
  }
  reported(id: string): void {
    this.db
      .prepare(
        "UPDATE journal SET phase='reported' WHERE id=? AND phase='pending'",
      )
      .run(id);
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.lock.close();
    this.closed = true;
  }
}
