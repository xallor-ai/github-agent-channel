import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ChannelConfig } from "./contracts.js";
import { StaleBinding, TaskStore } from "./store.js";
import { normalizeWebhook } from "./webhook.js";
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
  lookup = store.activeBinding.bind(store),
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
          accepted = store.accept(task);
        } catch (e) {
          if (!(e instanceof StaleBinding)) throw e;
          send(200, { ignored: true });
          return;
        }
        send(202, { taskId: accepted.task.id, duplicate: accepted.duplicate });
        return;
      }
      if (path.startsWith("/tasks/")) {
        if (!authorized(req.headers.authorization, adminToken)) {
          send(401, { error: "Unauthorized" });
          return;
        }
        const match = path.match(
          /^\/tasks\/([0-9a-f-]{36})(\/resolve|\/resolve-delivery)?$/,
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
            outcome: task.outcome,
          });
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
              validUrl =
                url.protocol === "https:" &&
                url.hostname === "github.com" &&
                !url.port &&
                !url.username &&
                !url.password &&
                !url.search &&
                (task.outcome?.publication?.kind === "pull_request"
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
            store.resolveUnknownDelivery(
              task.id,
              fields.resolution as "sent" | "failed",
              fields.url
                ? {
                    kind:
                      task.outcome?.publication.kind === "pull_request"
                        ? "pull_request"
                        : "comment",
                    url: fields.url as string,
                  }
                : undefined,
            );
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
