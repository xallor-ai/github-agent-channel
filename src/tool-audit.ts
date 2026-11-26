import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { buildRevision } from "./build-revision.js";
import { initializeToolAuditSchema } from "./store-schema.js";

export const cloudToolNames = [
  "read_issue",
  "read_file",
  "read_pull_diff",
  "review_access",
  "read_merge_facts",
] as const;
export type CloudToolName = (typeof cloudToolNames)[number];
export type ToolPhase = "requested" | "succeeded" | "failed";
export const toolFailureCodes = [
  "scope",
  "lease",
  "github_permission_or_resource",
  "invalid_evidence",
  "upstream_unavailable",
  "unknown",
] as const;
export type ToolFailureCode = (typeof toolFailureCodes)[number];
export interface CloudToolAudit {
  name: CloudToolName;
  requested: number;
  succeeded: number;
  failed: number;
  firstRequestedAt: number;
  lastRequestedAt: number;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastFailure: ToolFailureCode | null;
  buildSha: string | null;
}

// This file is separate from the task database layout. Only cloud-side
// observations enter it; no argument, result, failure text or runtime event.
export class ToolAuditStore {
  private readonly db: DatabaseSync;
  private readonly sha = buildRevision();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      initializeToolAuditSchema(this.db);
      if (path !== ":memory:") chmodSync(path, 0o600);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  record(
    task: string,
    name: CloudToolName,
    phase: ToolPhase,
    failure?: ToolFailureCode,
  ) {
    if (!cloudToolNames.includes(name)) throw Error("Invalid audit tool");
    if (
      phase === "failed"
        ? !failure || !toolFailureCodes.includes(failure)
        : failure !== undefined
    )
      throw Error("Invalid audit failure classification");
    const now = Date.now();
    if (phase === "requested") {
      this.db
        .prepare(
          "INSERT INTO toolAudit(taskId,name,requested,succeeded,failed,firstRequestedAt,lastRequestedAt,buildSha) " +
            "VALUES (?,?,1,0,0,?,?,?) ON CONFLICT(taskId,name) DO UPDATE SET requested=requested+1," +
            "lastRequestedAt=excluded.lastRequestedAt,buildSha=excluded.buildSha",
        )
        .run(task, name, now, now, this.sha);
      return;
    }
    if (phase !== "succeeded" && phase !== "failed")
      throw Error("Invalid audit phase");
    const update =
      phase === "succeeded"
        ? "succeeded=succeeded+1,lastSucceededAt=?"
        : "failed=failed+1,lastFailedAt=?,lastFailure=?";
    const changed = this.db
      .prepare(
        "UPDATE toolAudit SET " +
          update +
          " WHERE taskId=? AND name=? AND requested>succeeded+failed",
      )
      .run(now, ...(failure ? [failure] : []), task, name);
    if (!changed.changes) throw Error("No outstanding cloud tool request");
  }
  rows(task: string): CloudToolAudit[] {
    return this.db
      .prepare(
        "SELECT name,requested,succeeded,failed,firstRequestedAt,lastRequestedAt,lastSucceededAt,lastFailedAt,lastFailure,buildSha FROM toolAudit WHERE taskId=? ORDER BY name",
      )
      .all(task) as unknown as CloudToolAudit[];
  }
  close() {
    this.db.close();
  }
}
