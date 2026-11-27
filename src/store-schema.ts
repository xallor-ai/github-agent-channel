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
  expectedVersion = 2,
): boolean {
  const existing = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
    )
    .all();
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const app = db.prepare("PRAGMA application_id").get()?.application_id;
  const objects = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1",
    )
    .get();
  if (!objects && version === 0 && app === 0) return false;
  if (
    app !== 0 ||
    version !== expectedVersion ||
    existing.length !== Object.keys(tables).length
  )
    throw new StorageSchemaError(
      `Storage schema version ${expectedVersion} required; existing data was left intact. Use a new database path.`,
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
        `Storage schema version ${expectedVersion} required; incompatible table format left intact.`,
      );
  }
  return true;
}
export function initializeTaskSchema(db: DatabaseSync) {
  const exists = requireSchemaVersion(
    db,
    {
      bindings: [
        "installationId",
        "repositoryId",
        "deviceId",
        "owner",
        "repo",
        "administratorId",
        "revision",
        "declaration",
      ],
      reviewCandidates: ["taskId", "githubTime", "receivedAt", "input"],
      threadClosures: ["repositoryId", "thread", "closedAt"],
      revokedDevices: ["deviceId"],
      runtimePolls: [
        "deviceId",
        "runtimeType",
        "runtimeId",
        "deepReview",
        "nativeReview",
        "seenAt",
      ],
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
        "publicationBlocked",
        "githubTime",
      ],
      deliveries: [
        "deliveryId",
        "eventKey",
        "bindingId",
        "cursor",
        "taskId",
        "reason",
        "attempts",
        "duplicate",
        "githubTime",
        "reviewFollowUp",
      ],
      activities: [
        "cursor",
        "deliveryId",
        "installationId",
        "repositoryId",
        "bindingId",
        "thread",
        "receivedAt",
        "data",
      ],
      reactionCooldowns: ["installationId", "until"],
      clarifications: [
        "questionTaskId",
        "rootTaskId",
        "bindingId",
        "thread",
        "actorId",
        "askedAt",
        "expiresAt",
        "answerTaskId",
        "closed",
        "answerWithheldReason",
      ],
      clarificationSelections: ["taskId", "choices"],
      clarificationAttempts: ["taskId", "startedAt"],
      undeliveredAnswers: [
        "taskId",
        "questionTaskId",
        "attempt",
        "githubTime",
        "rejectedAt",
      ],
      clarificationCandidates: [
        "cursor",
        "questionTaskId",
        "input",
        "githubTime",
        "receivedAt",
      ],
      ownerReceipts: [
        "cursor",
        "deliveryId",
        "bindingId",
        "deviceId",
        "runtime",
        "confirmedAt",
        "repositoryId",
        "commentId",
        "taskId",
        "reactionStatus",
        "reason",
        "reactionId",
        "decision",
      ],
      assignments: [
        "taskId",
        "workerId",
        "leaseHash",
        "expiresAt",
        "resultDigest",
      ],
    },
    7,
  );
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
  );
  if (exists) return;
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE bindings (
      installationId INTEGER NOT NULL, repositoryId INTEGER NOT NULL, deviceId TEXT NOT NULL,
      owner TEXT NOT NULL, repo TEXT NOT NULL, administratorId INTEGER NOT NULL, revision INTEGER NOT NULL,
      declaration TEXT NOT NULL, PRIMARY KEY (installationId, repositoryId)
    ) STRICT;
    CREATE INDEX binding_device ON bindings(deviceId);
    CREATE TABLE revokedDevices(deviceId TEXT PRIMARY KEY) STRICT;
    CREATE TABLE runtimePolls(deviceId TEXT NOT NULL,runtimeType TEXT NOT NULL,runtimeId TEXT NOT NULL,deepReview INTEGER NOT NULL,nativeReview INTEGER NOT NULL,seenAt INTEGER NOT NULL,
      PRIMARY KEY(deviceId,runtimeType,runtimeId,deepReview,nativeReview)) STRICT;
    CREATE TRIGGER prune_runtime_poll AFTER UPDATE OF deviceId,declaration ON bindings BEGIN
      DELETE FROM runtimePolls WHERE deviceId=OLD.deviceId AND NOT EXISTS (
        SELECT 1 FROM bindings b WHERE b.deviceId=runtimePolls.deviceId AND json_extract(b.declaration,'$.enabled')=1
          AND json_extract(b.declaration,'$.responsibleAgent.type')=runtimePolls.runtimeType
          AND json_extract(b.declaration,'$.responsibleAgent.id')=runtimePolls.runtimeId
          AND json_extract(b.declaration,'$.responsibleAgent.deepReview')=runtimePolls.deepReview
          AND json_extract(b.declaration,'$.responsibleAgent.nativeReview')=runtimePolls.nativeReview);
    END;
    CREATE TABLE threadClosures(repositoryId INTEGER NOT NULL,thread TEXT NOT NULL,closedAt INTEGER,PRIMARY KEY(repositoryId,thread)) STRICT;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,deliveryId TEXT NOT NULL UNIQUE,eventKey TEXT NOT NULL,bindingId TEXT NOT NULL,installationId INTEGER NOT NULL,repositoryId INTEGER NOT NULL,owner TEXT NOT NULL,repo TEXT NOT NULL,actorId INTEGER NOT NULL,actorLogin TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','rejected','unknown')),deliveryStatus TEXT NOT NULL CHECK(deliveryStatus IN ('pending','sending','sent','skipped','failed','unknown')),createdAt INTEGER NOT NULL,error TEXT,target TEXT NOT NULL,source TEXT NOT NULL,outcome TEXT,runtime TEXT,publicationReceipt TEXT,publicationBlocked INTEGER NOT NULL DEFAULT 0,githubTime INTEGER);
    CREATE INDEX task_dedup_scope ON tasks(eventKey,githubTime);
    CREATE TABLE reviewCandidates(taskId TEXT PRIMARY KEY REFERENCES tasks(id), githubTime INTEGER NOT NULL, receivedAt INTEGER NOT NULL, input TEXT NOT NULL) STRICT;
    CREATE TRIGGER discard_started_candidate AFTER UPDATE OF status ON tasks WHEN NEW.status!='queued' BEGIN
      DELETE FROM reviewCandidates WHERE taskId=NEW.id;
    END;
    CREATE INDEX task_queue ON tasks(status,createdAt);
    CREATE INDEX task_scope ON tasks(installationId,repositoryId,status);
    CREATE TABLE activities(cursor INTEGER PRIMARY KEY AUTOINCREMENT,deliveryId TEXT NOT NULL UNIQUE,installationId INTEGER NOT NULL,repositoryId INTEGER NOT NULL,bindingId TEXT NOT NULL,thread TEXT NOT NULL,receivedAt INTEGER NOT NULL,data TEXT NOT NULL) STRICT;
    CREATE INDEX activity_thread ON activities(bindingId,thread,cursor);
    CREATE INDEX activity_scope ON activities(installationId,repositoryId,cursor);
    CREATE INDEX activity_age ON activities(receivedAt);
    CREATE TABLE deliveries(deliveryId TEXT PRIMARY KEY,eventKey TEXT,bindingId TEXT NOT NULL,cursor INTEGER NOT NULL,taskId TEXT REFERENCES tasks(id),reason TEXT NOT NULL,attempts INTEGER NOT NULL,duplicate INTEGER NOT NULL, githubTime INTEGER,reviewFollowUp TEXT) STRICT;
    CREATE UNIQUE INDEX delivery_event ON deliveries(eventKey);
    CREATE INDEX delivery_review_time ON deliveries(taskId,githubTime);
    CREATE INDEX delivery_scope ON deliveries(bindingId,cursor);
    CREATE TABLE assignments(taskId TEXT PRIMARY KEY REFERENCES tasks(id),workerId TEXT NOT NULL,leaseHash TEXT NOT NULL,expiresAt INTEGER NOT NULL,resultDigest TEXT);
    CREATE INDEX assignment_worker ON assignments(workerId);
    CREATE TABLE ownerReceipts(cursor INTEGER PRIMARY KEY,deliveryId TEXT NOT NULL UNIQUE REFERENCES deliveries(deliveryId),bindingId TEXT NOT NULL,deviceId TEXT NOT NULL,runtime TEXT NOT NULL,confirmedAt INTEGER NOT NULL,repositoryId INTEGER NOT NULL,commentId INTEGER,taskId TEXT UNIQUE REFERENCES tasks(id),reactionStatus TEXT CHECK(reactionStatus IN ('pending','sending','sent','failed','unknown')),reason TEXT CHECK(reason IN ('unconfirmed','lookup_rate_limited','scope','forbidden','rate_limited','comment_unavailable','unavailable')),reactionId INTEGER,decision TEXT CHECK(decision='silent_by_policy')) STRICT;
    CREATE TABLE reactionCooldowns(installationId INTEGER PRIMARY KEY,until INTEGER NOT NULL) STRICT;
    CREATE INDEX receipt_source ON ownerReceipts(repositoryId,commentId,cursor) WHERE commentId IS NOT NULL;
    CREATE UNIQUE INDEX reaction_source ON ownerReceipts(repositoryId,commentId) WHERE reactionStatus IS NOT NULL;
    CREATE INDEX pending_reactions ON ownerReceipts(cursor) WHERE reactionStatus='pending';
    CREATE TABLE clarifications(questionTaskId TEXT PRIMARY KEY REFERENCES tasks(id),rootTaskId TEXT NOT NULL REFERENCES tasks(id),bindingId TEXT NOT NULL,thread TEXT NOT NULL,actorId INTEGER NOT NULL,askedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,answerTaskId TEXT UNIQUE REFERENCES tasks(id),closed INTEGER NOT NULL DEFAULT 0,answerWithheldReason TEXT CHECK(answerWithheldReason IN ('closed','merged','unconfirmed'))) STRICT;
    CREATE INDEX clarification_match ON clarifications(bindingId,thread,actorId,askedAt) WHERE answerTaskId IS NULL AND closed=0;
    CREATE TABLE clarificationSelections(taskId TEXT PRIMARY KEY REFERENCES tasks(id),choices TEXT NOT NULL) STRICT;
    CREATE TABLE clarificationAttempts(taskId TEXT PRIMARY KEY REFERENCES tasks(id),startedAt INTEGER NOT NULL) STRICT;
    CREATE TABLE undeliveredAnswers(taskId TEXT PRIMARY KEY REFERENCES tasks(id), questionTaskId TEXT NOT NULL REFERENCES clarifications(questionTaskId), attempt INTEGER NOT NULL,githubTime INTEGER NOT NULL,rejectedAt INTEGER NOT NULL, UNIQUE(questionTaskId,attempt)) STRICT;
    CREATE TABLE clarificationCandidates(cursor INTEGER PRIMARY KEY,questionTaskId TEXT NOT NULL REFERENCES tasks(id),input TEXT NOT NULL,githubTime INTEGER NOT NULL,receivedAt INTEGER NOT NULL) STRICT;
    CREATE INDEX clarification_inflight ON clarificationCandidates(questionTaskId,githubTime,cursor);
    CREATE INDEX clarification_candidate_age ON clarificationCandidates(receivedAt,cursor);
    CREATE INDEX clarification_sending ON tasks(bindingId,actorId,json_extract(target,'$.kind'),json_extract(target,'$.number')) WHERE deliveryStatus IN ('sending','unknown') AND json_extract(outcome,'$.publication.kind')='clarification';
    PRAGMA user_version=7; COMMIT;`);
}

// The task database rejects extra tables; keep the cloud tool ledger independent
// and verify its exact layout before writing to an existing file.
export function initializeToolAuditSchema(db: DatabaseSync) {
  const layout =
    "CREATE TABLE toolAudit(taskId TEXT NOT NULL,name TEXT NOT NULL,requested INTEGER NOT NULL,succeeded INTEGER NOT NULL,failed INTEGER NOT NULL,firstRequestedAt INTEGER NOT NULL,lastRequestedAt INTEGER NOT NULL,lastSucceededAt INTEGER,lastFailedAt INTEGER,buildSha TEXT,lastFailure TEXT CHECK(lastFailure IN ('scope','lease','github_permission_or_resource','invalid_evidence','upstream_unavailable','unknown')),PRIMARY KEY(taskId,name)) STRICT";
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  try {
    const objects = db
      .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
      .all();
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const app = db.prepare("PRAGMA application_id").get()?.application_id;
    if (!objects.length && version === 0 && app === 0) {
      db.exec(layout);
      db.exec("PRAGMA user_version=2");
    } else if (
      version !== 2 ||
      app !== 0 ||
      objects.length !== 1 ||
      objects[0].sql !== layout
    ) {
      throw new StorageSchemaError(
        "Incompatible tool audit database; existing data left intact.",
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
