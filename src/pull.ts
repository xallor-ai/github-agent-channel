import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AccessDenied, type GitHubClient, type Task } from "./contracts.js";
import {
  TaskStore,
  AssignmentConflict,
  type AssignmentResult,
} from "./store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const leaseSchema = z.string().min(32).max(256);
const toolSchema = z.strictObject({
  leaseToken: leaseSchema,
  name: z.enum(["read_issue", "read_file"]),
  args: z.unknown(),
});
const resultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    leaseToken: leaseSchema,
    status: z.literal("succeeded"),
    outcome: outcomeSchema,
  }),
  z.strictObject({
    leaseToken: leaseSchema,
    status: z.literal("failed"),
  }),
  z.strictObject({
    leaseToken: leaseSchema,
    status: z.literal("unknown"),
  }),
]);
import {
  outcomeSchema,
  validateTaskOutcome,
  runtimeEventSchema,
  MAX_RESULT_BYTES,
} from "./outcomes.js";
class BodyTooLarge extends Error {}
class StaleAssignment extends Error {}
async function jsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class PullCoordinator {
  constructor(
    private readonly store: TaskStore,
    private readonly github: GitHubClient,
    private readonly config: { workerId: string; timeoutMs: number },
    private readonly token: string,
  ) {
    if (
      !token.trim() ||
      !config.workerId.trim() ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 3600000
    )
      throw new Error("Invalid pull coordinator configuration");
  }
  expire(): void {
    this.store.expireTasks();
  }
  private assignment(id: string, lease: string): Task {
    const task = this.store.assignedTask(id, this.config.workerId, hash(lease));
    if (!task) throw new StaleAssignment();
    return task;
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url?.split("?")[0] ?? "";
    if (!path.startsWith("/connector/")) return false;
    const send = (status: number, value?: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Channel-Protocol": "2",
      });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + this.token);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      send(401, { error: "Unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      send(405, { error: "Method not allowed" });
      return true;
    }
    try {
      this.expire();
      if (path === "/connector/v2/claim") {
        z.strictObject({}).parse(await jsonBody(req, 4096));
        const leaseToken = randomBytes(32).toString("hex"),
          expiresAt = Date.now() + this.config.timeoutMs;
        const task = this.store.claimAssignment(
          this.config.workerId,
          hash(leaseToken),
          expiresAt,
        );
        if (!task) {
          send(204);
          return true;
        }
        try {
          await this.github.authorize(task);
        } catch (error) {
          // No request has reached the remote runtime; keep details out of the response.
          if (this.store.get(task.id)?.status === "running")
            this.store.rejectAssignment(
              task.id,
              error instanceof AccessDenied ? "rejected" : "failed",
              error instanceof AccessDenied
                ? "Task authorization denied"
                : "Task authorization unavailable",
            );
          // This is a denied GitHub actor, not a rejected connector identity.
          // Keep the healthy poller alive and disclose no rejected task content.
          if (error instanceof AccessDenied) send(204);
          else send(503, { error: "Task authorization unavailable" });
          return true;
        }
        this.assignment(task.id, leaseToken);
        send(200, { task, leaseToken, expiresAt });
        return true;
      }
      const match = path.match(
        /^\/connector\/v2\/tasks\/([0-9a-f-]{36})\/(tool|result|execution)$/,
      );
      if (!match) {
        send(404, { error: "Not found" });
        return true;
      }
      const [, id, action] = match;
      if (action === "execution") {
        const data = z
          .strictObject({ leaseToken: leaseSchema, event: runtimeEventSchema })
          .parse(await jsonBody(req, 4096));
        const task = this.assignment(id, data.leaseToken);
        try {
          this.store.recordRuntime(task.id, data.event);
        } catch (error) {
          if (error instanceof AssignmentConflict) throw new StaleAssignment();
          throw error;
        }
        send(200, { accepted: true });
        return true;
      }
      if (action === "tool") {
        const data = toolSchema.parse(await jsonBody(req, 10000));
        const args =
          data.name === "read_issue"
            ? z.strictObject({}).parse(data.args)
            : z
                .strictObject({ path: z.string().min(1).max(1024) })
                .parse(data.args);
        const task = this.assignment(id, data.leaseToken);
        await this.github.authorize(task);
        this.assignment(id, data.leaseToken);
        const output =
          data.name === "read_issue"
            ? await this.github.readIssue(task)
            : await this.github.readFile(task, (args as { path: string }).path);
        this.assignment(id, data.leaseToken);
        send(200, output);
        return true;
      }
      const data = resultSchema.parse(await jsonBody(req, MAX_RESULT_BYTES));
      if (data.status === "succeeded") {
        const task = this.store.get(id);
        if (task) {
          try {
            validateTaskOutcome(task, data.outcome);
          } catch {
            send(400, { error: "Invalid publication target" });
            return true;
          }
        }
      }
      const result: AssignmentResult =
        data.status === "succeeded"
          ? { status: data.status, outcome: data.outcome }
          : { status: data.status };
      // Canonical field order ensures JSON key order does not defeat result deduplication.
      const digest = hash(JSON.stringify(result));
      let duplicate: boolean;
      try {
        duplicate = this.store.finishAssignment(
          id,
          this.config.workerId,
          hash(data.leaseToken),
          result,
          digest,
        );
      } catch (error) {
        if (error instanceof AssignmentConflict) throw new StaleAssignment();
        throw error;
      }
      send(200, { accepted: true, duplicate });
      return true;
    } catch (error) {
      if (error instanceof BodyTooLarge)
        send(413, { error: "Request too large" });
      else if (error instanceof z.ZodError || error instanceof SyntaxError)
        send(400, { error: "Invalid connector request" });
      else if (error instanceof AccessDenied)
        send(403, { error: "Task authorization denied" });
      else if (error instanceof StaleAssignment)
        send(409, { error: "Assignment is not active or result conflicts" });
      else send(503, { error: "Connector operation unavailable" });
      return true;
    }
  }
}
