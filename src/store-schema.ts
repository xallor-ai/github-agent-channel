import type { DatabaseSync } from "node:sqlite";

/** Safe to display at startup: contains no stored content or configuration secrets. */
export class StorageSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageSchemaError";
  }
}

/** Existing data must already use the current contract. Never migrate implicitly. */
export function requireSchemaVersion(
  db: DatabaseSync,
  tables: Record<string, string[]>,
): boolean {
  const existing = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
    )
    .all();
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (existing.length === 0 && version === 0) return false;
  if (version !== 2 || existing.length !== Object.keys(tables).length)
    throw new StorageSchemaError(
      "Storage schema version 2 required; existing data was left intact. Use a new database path.",
    );
  for (const [table, columns] of Object.entries(tables)) {
    const actual = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String(c.name));
    if (
      actual.length !== columns.length ||
      columns.some((c) => !actual.includes(c))
    )
      throw new StorageSchemaError(
        "Storage schema version 2 required; incompatible table format left intact.",
      );
  }
  return true;
}
export function initializeTaskSchema(db: DatabaseSync) {
  const exists = requireSchemaVersion(db, {
    tasks: [
      "id",
      "deliveryId",
      "eventKey",
      "bindingId",
      "installationId",
      "repositoryId",
      "owner",
      "repo",
      "actorId",
      "actorLogin",
      "prompt",
      "status",
      "deliveryStatus",
      "createdAt",
      "error",
      "target",
      "source",
      "outcome",
      "runtime",
      "publicationReceipt",
    ],
    deliveries: ["deliveryId", "taskId"],
    assignments: [
      "taskId",
      "workerId",
      "leaseHash",
      "expiresAt",
      "resultDigest",
    ],
  });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
  );
  if (exists) return;
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,deliveryId TEXT NOT NULL UNIQUE,eventKey TEXT NOT NULL UNIQUE,bindingId TEXT NOT NULL,installationId INTEGER NOT NULL,repositoryId INTEGER NOT NULL,owner TEXT NOT NULL,repo TEXT NOT NULL,actorId INTEGER NOT NULL,actorLogin TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','rejected','unknown')),deliveryStatus TEXT NOT NULL CHECK(deliveryStatus IN ('pending','sending','sent','skipped','failed','unknown')),createdAt INTEGER NOT NULL,error TEXT,target TEXT NOT NULL,source TEXT NOT NULL,outcome TEXT,runtime TEXT,publicationReceipt TEXT);
    CREATE INDEX task_queue ON tasks(status,createdAt);
    CREATE INDEX task_binding ON tasks(bindingId,status);
    CREATE TABLE deliveries(deliveryId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id));
    CREATE TABLE assignments(taskId TEXT PRIMARY KEY REFERENCES tasks(id),workerId TEXT NOT NULL,leaseHash TEXT NOT NULL,expiresAt INTEGER NOT NULL,resultDigest TEXT);
    CREATE INDEX assignment_worker ON assignments(workerId);
    PRAGMA user_version=2; COMMIT;`);
}
