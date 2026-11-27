import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runtimeProfileSchema } from "./runtime-profile.js";
import { failureCodes } from "./runtime-failure.js";
import { revisionSchema } from "./outcomes.js";
import { summarizeReviewInput } from "./review-input.js";
import { mergeSnapshotPublishable } from "./merge-assessment.js";
import { cloudToolNames, type ToolFailureCode } from "./tool-audit.js";
import { z } from "zod";
import {
  AccessDenied,
  PullTargetRejected,
  isAutomaticReview,
  observedReviewDrift,
  type GitHubClient,
  type PullRevision,
  type Task,
} from "./contracts.js";
import {
  TaskStore,
  AssignmentConflict,
  InvalidAssignmentOutcome,
  type AssignmentResult,
} from "./store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const leaseSchema = z.string().min(32).max(256);
const toolSchema = z.strictObject({
  leaseToken: leaseSchema,
  name: z.enum(cloudToolNames),
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
    failure: failureCodes.failed.optional(),
  }),
  z.strictObject({
    leaseToken: leaseSchema,
    status: z.literal("unknown"),
    failure: failureCodes.unknown.optional(),
  }),
]);
import {
  outcomeSchema,
  runtimeEventSchema,
  MAX_RESULT_BYTES,
} from "./outcomes.js";
class BodyTooLarge extends Error {}
class StaleAssignment extends Error {}
// Only called for an admitted read, after the connector request has been parsed.
// Do not inspect upstream messages, headers or bodies to guess a root cause.
function classifyReadFailure(error: unknown): ToolFailureCode {
  if (error instanceof StaleAssignment) return "lease";
  if (error instanceof AccessDenied) return "scope";
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return "invalid_evidence";
  // Octokit can surface an HTTP 200 GraphQL response as an error. Inspect
  // only bounded, structured types; a mixed response has no single cause.
  if (
    error instanceof Error &&
    error.name === "GraphqlResponseError" &&
    "errors" in error
  ) {
    const causes: unknown = error.errors;
    if (
      Array.isArray(causes) &&
      causes.length > 0 &&
      causes.length <= 16 &&
      causes.every(
        (v: unknown) =>
          v !== null &&
          typeof v === "object" &&
          "type" in v &&
          (v.type === "FORBIDDEN" || v.type === "NOT_FOUND"),
      )
    )
      return "github_permission_or_resource";
  }
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  if (status === 401 || status === 403 || status === 404)
    return "github_permission_or_resource";
  if (
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599)
  )
    return "upstream_unavailable";
  return "unknown";
}
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
    private readonly config: { timeoutMs: number },
    private readonly authenticate: (
      credential: string,
    ) => { deviceId: string } | undefined,
  ) {
    if (
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 3600000
    )
      throw new Error("Invalid pull coordinator configuration");
  }
  expire(): void {
    this.store.expireTasks();
  }
  private assignment(id: string, lease: string, workerId: string): Task {
    const task = this.store.assignedTask(id, workerId, hash(lease));
    if (!task) throw new StaleAssignment();
    return task;
  }
  private recordDrift(
    task: Task,
    error: unknown,
    lease: string,
    workerId: string,
    credential: string | undefined,
  ) {
    const observed = observedReviewDrift(task, error);
    if (
      observed &&
      credential &&
      this.authenticate(credential)?.deviceId === workerId &&
      this.store.assignedTask(task.id, workerId, hash(lease))
    )
      this.store.recordReviewDrift(task.id, observed);
  }
  private checkReviewAccess(
    task: Task,
    workerId: string,
    credential: string | undefined,
  ) {
    const binding = this.store.activeBinding(
      task.installationId,
      task.repositoryId,
    );
    if (
      !credential ||
      this.authenticate(credential)?.deviceId !== workerId ||
      binding?.deviceId !== workerId ||
      binding.id !== task.bindingId ||
      binding.deepReview !== true ||
      task.target.kind !== "pull_request" ||
      task.target.revision?.headRepoId !== task.repositoryId ||
      task.target.revision.baseRepoId !== task.repositoryId
    )
      throw new AccessDenied("Deep review unavailable for this assignment");
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
    const credential = /^Bearer ([^\s]+)$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    const workerId = credential && this.authenticate(credential)?.deviceId;
    if (!workerId) {
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
        const { runtime } = z
          .strictObject({ runtime: runtimeProfileSchema })
          .parse(await jsonBody(req, 4096));
        const leaseToken = randomBytes(32).toString("hex"),
          expiresAt = Date.now() + this.config.timeoutMs;
        let task = this.store.claimAssignment(
          workerId,
          hash(leaseToken),
          expiresAt,
          Date.now(),
          runtime,
        );
        if (!task) {
          this.store.recordRuntimePoll(workerId, runtime);
          send(204);
          return true;
        }
        try {
          if (task.target.kind === "pull_request" && !task.target.revision) {
            if (
              task.source.event !== "issue_comment" ||
              !this.github.resolvePullRevision
            )
              throw new AccessDenied("PR revision unavailable");
            const revision = revisionSchema.parse(
              await this.github.resolvePullRevision(task),
            );
            task = this.store.pinPullRevision(
              task.id,
              workerId,
              hash(leaseToken),
              revision,
            );
          }
          await this.github.authorize(task);
          this.assignment(task.id, leaseToken, workerId);
        } catch (error) {
          // No request has reached the remote runtime; keep details out of the response.
          this.recordDrift(task, error, leaseToken, workerId, credential);
          this.store.rejectUndeliveredClaim(
            task.id,
            workerId,
            hash(leaseToken),
            error instanceof AccessDenied ? "rejected" : "failed",
            error instanceof PullTargetRejected
              ? error.reason
              : error instanceof AccessDenied
                ? "Task authorization denied"
                : "Task authorization unavailable",
          );
          // This is a denied GitHub actor, not a rejected connector identity.
          // Keep the healthy poller alive and disclose no rejected task content.
          if (error instanceof AccessDenied) {
            this.store.recordRuntimePoll(workerId, runtime);
            send(204);
          } else send(503, { error: "Task authorization unavailable" });
          return true;
        }
        const binding = this.store.activeBinding(
          task.installationId,
          task.repositoryId,
        );
        if (!binding || binding.id !== task.bindingId)
          throw new StaleAssignment();
        const threadContext = this.store
          .recentThread(task)
          .filter((e) => e.deliveryId !== task.deliveryId)
          .map((e) => ({
            actor: e.actorLogin,
            event: e.source.event,
            excerpt: e.excerpt,
            truncated: e.truncated,
          }));
        this.store.recordRuntimePoll(workerId, runtime);
        send(200, {
          task: {
            ...task,
            ...(task.target.kind === "pull_request"
              ? {
                  reviewPolicy: {
                    deepReview: !!binding.deepReview,
                    nativeReview: !!binding.nativeReview,
                  },
                }
              : {}),
            threadContext,
          },
          leaseToken,
          expiresAt,
        });
        return true;
      }
      const match = path.match(
        /^\/connector\/v2\/tasks\/([0-9a-f-]{36})\/(source-grant|tool|result|execution)$/,
      );
      if (!match) {
        send(404, { error: "Not found" });
        return true;
      }
      const [, id, action] = match;
      if (action === "source-grant") {
        const { leaseToken } = z
          .strictObject({ leaseToken: leaseSchema })
          .parse(await jsonBody(req, 4096));
        const task = this.assignment(id, leaseToken, workerId);
        const checkAssignment = () => {
          this.assignment(id, leaseToken, workerId);
          this.checkReviewAccess(task, workerId, credential);
        };
        checkAssignment();
        if (!this.github.issueSourceGrant)
          throw new AccessDenied("Source grant unavailable");
        const grant = await this.github
          .issueSourceGrant(task, checkAssignment)
          .catch((error: unknown) => {
            this.recordDrift(task, error, leaseToken, workerId, credential);
            throw error;
          });
        checkAssignment();
        send(200, grant);
        return true;
      }
      if (action === "execution") {
        const data = z
          .strictObject({ leaseToken: leaseSchema, event: runtimeEventSchema })
          .parse(await jsonBody(req, 4096));
        const task = this.assignment(id, data.leaseToken, workerId);
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
          data.name !== "read_file"
            ? z.strictObject({}).parse(data.args)
            : z
                .strictObject({ path: z.string().min(1).max(1024) })
                .parse(data.args);
        const task = this.assignment(id, data.leaseToken, workerId);
        this.store.recordToolCall(id, data.name, "requested");
        let output: unknown;
        let observedRevision: PullRevision | undefined;
        let fenceReason: "closed" | "merged" | "unconfirmed" | undefined;
        try {
          // The merge reader checks the binding, manager and actor before and after its read.
          // Generic execution authorization also requires an open, unchanged target, which
          // would hide exactly the terminal/drift facts this read is meant to report.
          if (data.name !== "read_merge_facts")
            await this.github.authorize(task);
          this.assignment(id, data.leaseToken, workerId);
          if (data.name === "read_file")
            output = await this.github.readFile(
              task,
              (args as { path: string }).path,
            );
          else if (data.name === "read_issue") {
            if (task.target.kind === "repository")
              throw new AccessDenied("No issue scope");
            output = await this.github.readIssue(task);
          } else {
            if (task.target.kind !== "pull_request" || !task.target.revision)
              throw new AccessDenied("No pinned PR");
            if (data.name === "read_pull_diff" && this.github.readPullDiff)
              output = await this.github.readPullDiff(task);
            else if (
              data.name === "read_merge_facts" &&
              this.github.readMergeFacts
            ) {
              const facts = await this.github.readMergeFacts(task);
              const pin = task.target.revision,
                last = facts.observedRevision;
              const repository = task.owner + "/" + task.repo;
              if (
                isAutomaticReview(task) &&
                !facts.stable &&
                facts.state === "open" &&
                last &&
                facts.number === task.target.number &&
                facts.repository === repository &&
                facts.base.repository === repository &&
                facts.head.repository === repository &&
                facts.base.id === task.repositoryId &&
                facts.head.id === task.repositoryId &&
                facts.base.sha === pin.baseSha &&
                facts.head.sha === pin.headSha &&
                (pin.baseSha !== last.baseSha || pin.headSha !== last.headSha)
              )
                observedRevision = {
                  ...pin,
                  baseSha: last.baseSha,
                  headSha: last.headSha,
                };
              if (task.continuation && !mergeSnapshotPublishable(facts))
                fenceReason =
                  facts.state === "closed" || facts.state === "merged"
                    ? facts.state
                    : "unconfirmed";
              output = facts;
            } else if (data.name === "review_access") {
              this.checkReviewAccess(task, workerId, credential);
              output = { authorized: true };
            } else throw new AccessDenied("Review capability not enabled");
          }
          this.assignment(id, data.leaseToken, workerId);
          if (
            !credential ||
            this.authenticate(credential)?.deviceId !== workerId
          )
            throw new AccessDenied("Device no longer authorized");
          if (fenceReason)
            this.store.fenceContinuationPublication(task, fenceReason);
          if (observedRevision)
            this.store.recordReviewDrift(id, observedRevision);
          if (data.name === "read_pull_diff") {
            const summary = summarizeReviewInput(task, output);
            if (summary) this.store.recordReviewInput(task.id, summary);
          }
        } catch (error) {
          this.recordDrift(task, error, data.leaseToken, workerId, credential);
          this.store.recordToolCall(
            id,
            data.name,
            "failed",
            classifyReadFailure(error),
          );
          if (error instanceof AccessDenied || error instanceof StaleAssignment)
            throw error;
          // An upstream parse failure is not an invalid connector request.
          send(503, { error: "Cloud tool read unavailable" });
          return true;
        }
        this.store.recordToolCall(id, data.name, "succeeded");
        send(200, output);
        return true;
      }
      const data = resultSchema.parse(await jsonBody(req, MAX_RESULT_BYTES));
      const result: AssignmentResult =
        data.status === "succeeded"
          ? { status: data.status, outcome: data.outcome }
          : {
              status: data.status,
              ...(data.failure && { failure: data.failure }),
            };
      // Canonical field order ensures JSON key order does not defeat result deduplication.
      const digest = hash(JSON.stringify(result));
      let duplicate: boolean;
      try {
        duplicate = this.store.finishAssignment(
          id,
          workerId,
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
      else if (error instanceof InvalidAssignmentOutcome)
        send(400, { error: "Invalid assignment outcome" });
      else if (error instanceof AccessDenied)
        send(403, { error: "Task authorization denied" });
      else if (error instanceof StaleAssignment)
        send(409, { error: "Assignment is not active or result conflicts" });
      else send(503, { error: "Connector operation unavailable" });
      return true;
    }
  }
}
