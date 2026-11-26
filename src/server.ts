import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type {
  ChannelConfig,
  BindingLookup,
  GitHubClient,
  PublicationReceipt,
} from "./contracts.js";
import { StaleBinding, TaskStore } from "./store.js";
import { normalizeWebhook } from "./webhook.js";
import { AccessDenied } from "./contracts.js";
import { assessMerge } from "./merge-assessment.js";
function authorized(header: string | undefined, token: string) {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req: IncomingMessage, max = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > max) throw Error("Request too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export function createChannelServer(
  config: ChannelConfig,
  store: TaskStore,
  webhookSecret: string,
  adminToken: string,
  coordinator?: {
    handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  },
  lookup: BindingLookup = store.activeBinding.bind(store),
  reconcileReview?: GitHubClient["reconcileReview"],
  readMergeFacts?: GitHubClient["readMergeFacts"],
) {
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    const path = req.url?.split("?")[0] ?? "";
    try {
      if (coordinator && (await coordinator.handle(req, res))) return;
      if (req.method === "GET" && path === "/healthz") {
        send(200, { status: "ok", scope: "process-liveness" });
        return;
      }
      if (req.method === "POST" && path === "/webhooks/github") {
        let task;
        try {
          task = await normalizeWebhook(
            { github: config.github, lookup },
            await body(req),
            {
              signature: String(req.headers["x-hub-signature-256"] ?? ""),
              delivery: String(req.headers["x-github-delivery"] ?? ""),
              event: String(req.headers["x-github-event"] ?? ""),
            },
            webhookSecret,
          );
        } catch {
          send(400, { error: "Invalid webhook" });
          return;
        }
        if (!task) {
          send(200, { ignored: true });
          return;
        }
        let accepted;
        try {
          if ("closure" in task) {
            store.closeThread(task.closure);
            send(200, { ignored: true });
            return;
          }
          accepted = store.observe(task);
        } catch (e) {
          if (!(e instanceof StaleBinding)) throw e;
          send(200, { ignored: true });
          return;
        }
        if (accepted.taskId)
          send(202, { taskId: accepted.taskId, duplicate: accepted.duplicate });
        else
          send(200, {
            observed: true,
            reason: accepted.reason,
            taskId: null,
            duplicate: accepted.duplicate,
          });
        return;
      }
      if (path.startsWith("/activities/")) {
        if (!authorized(req.headers.authorization, adminToken)) {
          send(401, { error: "Unauthorized" });
          return;
        }
        const match = /^\/activities\/([0-9a-f-]{36})(\/thread)?$/i.exec(path);
        const receipt =
          req.method === "GET" && match && store.activityReceipt(match[1]);
        if (!receipt) {
          send(404, { error: "Not found" });
          return;
        }
        if (match[2]) {
          if (!receipt.activity) {
            send(410, { error: "Activity details expired" });
            return;
          }
          send(200, {
            activities: store.recentThread({
              ...receipt.activity,
              deliveryId: "",
            }),
          });
        } else send(200, receipt);
        return;
      }
      const byComment =
        /^\/repositories\/([1-9]\d{0,15})\/comments\/([1-9]\d{0,15})\/task$/.exec(
          path,
        );
      if (byComment || path.startsWith("/tasks/")) {
        if (!authorized(req.headers.authorization, adminToken)) {
          send(401, { error: "Unauthorized" });
          return;
        }
        if (byComment) {
          const repo = Number(byComment[1]),
            comment = Number(byComment[2]);
          const task =
            req.method === "GET" &&
            Number.isSafeInteger(repo) &&
            Number.isSafeInteger(comment) &&
            store.taskForComment(repo, comment);
          if (!task) send(404, { error: "Not found" });
          else
            send(200, {
              id: task.id,
              target: task.target,
              source: task.source,
              runtime: task.runtime,
              status: task.status,
              deliveryStatus: task.deliveryStatus,
              publicationReceipt: task.publicationReceipt,
              toolAudit: store.toolAudit(task.id),
            });
          return;
        }
        const match = path.match(
          /^\/tasks\/([0-9a-f-]{36})(\/resolve|\/resolve-delivery|\/thread|\/lookup-review|\/merge-facts)?$/,
        );
        if (!match) {
          send(404, { error: "Not found" });
          return;
        }
        const task = store.get(match[1]);
        if (!task) {
          send(404, { error: "Not found" });
          return;
        }
        if (req.method === "GET" && match[2] === "/thread") {
          send(200, { activities: store.recentThread(task) });
          return;
        }
        if (req.method === "GET" && match[2] === "/merge-facts") {
          if (task.target.kind !== "pull_request" || !task.target.revision) {
            send(409, { error: "No pinned pull request" });
          } else if (!readMergeFacts) {
            send(503, { error: "Merge facts unavailable" });
          } else
            try {
              const facts = await readMergeFacts(task);
              send(200, {
                source: "current_readback",
                facts,
                assessment: assessMerge(facts),
              });
            } catch (error) {
              if (error instanceof AccessDenied)
                send(403, { error: "Task authorization denied" });
              else send(503, { error: "Merge facts unavailable" });
            }
          return;
        }
        if (req.method === "GET" && !match[2]) {
          send(200, {
            id: task.id,
            status: task.status,
            deliveryStatus: task.deliveryStatus,
            error: task.error,
            publicationReceipt: task.publicationReceipt,
            target: task.target,
            source: task.source,
            runtime: task.runtime,
            toolAudit: store.toolAudit(task.id),
            outcome: task.outcome,
          });
          return;
        }
        if (req.method === "GET" && match[2] === "/lookup-review") {
          if (
            !reconcileReview ||
            task.deliveryStatus !== "unknown" ||
            task.outcome?.publication.kind !== "review"
          ) {
            send(409, { error: "No unknown native review to verify" });
            return;
          }
          try {
            const receipt = await reconcileReview(task);
            send(200, { kind: "review", ...receipt });
          } catch {
            send(409, {
              error:
                "Could not uniquely verify native review; delivery remains unknown",
            });
          }
          return;
        }
        if (req.method === "POST" && match[2] === "/resolve-delivery") {
          let data: unknown;
          try {
            data = JSON.parse((await body(req, 4096)).toString());
          } catch {
            send(400, { error: "Invalid reconciliation request" });
            return;
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            send(400, { error: "Invalid reconciliation request" });
            return;
          }
          const fields = data as Record<string, unknown>;
          if (
            Object.keys(fields).some(
              (key) =>
                !["confirmedReconciled", "resolution", "url"].includes(key),
            ) ||
            fields.confirmedReconciled !== true ||
            (fields.resolution !== "sent" && fields.resolution !== "failed") ||
            (fields.url !== undefined && typeof fields.url !== "string")
          ) {
            send(400, {
              error: "Confirm reconciliation and resolution sent or failed",
            });
            return;
          }
          const publicationKind = task.outcome?.publication.kind;
          let reviewId: number | undefined;
          let validUrl =
            fields.url === undefined && fields.resolution === "failed";
          if (typeof fields.url === "string") {
            try {
              const url = new URL(fields.url);
              const issueNumber =
                task.target.kind !== "repository"
                  ? task.target.number
                  : undefined;
              const paths = [
                `/${task.owner}/${task.repo}/issues/${issueNumber}`,
                `/${task.owner}/${task.repo}/pull/${issueNumber}`,
              ];
              if (publicationKind === "review") {
                reviewId = /^#pullrequestreview-[1-9][0-9]*$/.test(url.hash)
                  ? Number(url.hash.slice("#pullrequestreview-".length))
                  : undefined;
                validUrl =
                  fields.resolution === "sent" &&
                  task.target.kind === "pull_request" &&
                  Number.isSafeInteger(reviewId) &&
                  fields.url ===
                    `https://github.com${paths[1]}#pullrequestreview-${reviewId}`;
              } else {
                validUrl =
                  url.protocol === "https:" &&
                  url.hostname === "github.com" &&
                  !url.port &&
                  !url.username &&
                  !url.password &&
                  !url.search &&
                  (publicationKind === "pull_request"
                    ? url.pathname.startsWith(
                        `/${task.owner}/${task.repo}/pull/`,
                      ) &&
                      /^[1-9][0-9]*$/.test(
                        url.pathname.slice(
                          `/${task.owner}/${task.repo}/pull/`.length,
                        ),
                      ) &&
                      !url.hash
                    : paths.includes(url.pathname) &&
                      /^#issuecomment-[1-9][0-9]*$/.test(url.hash));
              }
            } catch {
              validUrl = false;
            }
          }
          if (!validUrl) {
            send(400, {
              error:
                "Provide a reconciled publication URL within this task scope",
            });
            return;
          }
          try {
            let receipt: PublicationReceipt | undefined;
            if (typeof fields.url === "string") {
              if (publicationKind === "review") {
                if (
                  !reconcileReview ||
                  reviewId === undefined ||
                  task.deliveryStatus !== "unknown"
                )
                  throw Error("Cannot verify review");
                const verified = await reconcileReview(task, reviewId);
                if (verified.url !== fields.url || verified.id !== reviewId)
                  throw Error("Review identity mismatch");
                receipt = { kind: "review", ...verified };
              } else {
                receipt = {
                  kind:
                    publicationKind === "pull_request"
                      ? "pull_request"
                      : "comment",
                  url: fields.url,
                };
              }
            }
            store.resolveUnknownDelivery(task.id, fields.resolution, receipt);
            send(200, { resolved: true });
          } catch {
            send(409, { error: "Delivery cannot be resolved" });
          }
          return;
        }
        if (req.method === "POST" && match[2] === "/resolve") {
          let data: unknown;
          try {
            data = JSON.parse((await body(req, 4096)).toString());
          } catch {
            send(400, { error: "Invalid reconciliation request" });
            return;
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            send(400, { error: "Invalid reconciliation request" });
            return;
          }
          const fields = data as Record<string, unknown>;
          // Resolving an ambiguous execution requires an explicit operator reconciliation, never auto replay.
          if (
            Object.keys(fields).some(
              (key) => !["confirmedStopped", "resolution"].includes(key),
            ) ||
            fields.confirmedStopped !== true ||
            fields.resolution !== "failed"
          ) {
            send(400, {
              error: "Confirm remote task stopped and resolution failed",
            });
            return;
          }
          try {
            store.resolveUnknown(task.id, "failed");
            send(200, { resolved: true });
          } catch {
            send(409, { error: "Task cannot be resolved" });
          }
          return;
        }
      }
      send(404, { error: "Not found" });
    } catch {
      send(500, { error: "Request could not be completed" });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
