import { setTimeout as delay } from "node:timers/promises";
import { RuntimeFailure } from "./runtime-failure.js";
import { dirname, join } from "node:path";
import { OpenClawConnector } from "./connector.js";
import { openReviewSnapshot } from "./review-snapshot.js";
import { prepareReviewCache } from "./review-cache.js";
import { runtimeProfile } from "./runtime-profile.js";
import { runActivityInbox } from "./agent-inbox.js";
import { z } from "zod";
import { createRuntime } from "./runtime-factory.js";
import {
  targetSchema,
  sourceSchema,
  validateOutcome,
  validateTaskOutcome,
  runtimeEventSchema,
  outcomeSchema,
  publicationReceiptSchema,
} from "./outcomes.js";
import { AmbiguousExecution, type RuntimeConnector } from "./contracts.js";
import { loadAgentConfig, type AgentConfig } from "./agent-config.js";
import {
  AgentStore,
  type Assignment,
  type AgentResult,
} from "./agent-store.js";

const uuid = z.string().uuid();
const assignmentSchema = z.strictObject({
  task: z.strictObject({
    reviewPolicy: z.strictObject({
      deepReview: z.boolean(),
      nativeReview: z.boolean(),
    }),
    threadContext: z
      .array(
        z.strictObject({
          actor: z.string().max(100),
          event: z.string().max(100),
          excerpt: z.string().max(1024),
          truncated: z.boolean(),
        }),
      )
      .max(8),
    id: uuid,
    prompt: z.string().max(16000),
    deliveryId: z.string(),
    bindingId: z.string(),
    installationId: z.number().int().positive(),
    repositoryId: z.number().int().positive(),
    owner: z.string(),
    repo: z.string(),
    actorId: z.number().int().positive(),
    actorLogin: z.string(),
    target: targetSchema,
    source: sourceSchema,
    status: z.literal("running"),
    deliveryStatus: z.enum([
      "pending",
      "sending",
      "sent",
      "skipped",
      "failed",
      "unknown",
    ]),
    outcome: outcomeSchema.nullable(),
    runtime: runtimeEventSchema.nullable(),
    publicationReceipt: publicationReceiptSchema.nullable(),
    error: z.string().nullable(),
    createdAt: z.number(),
  }),
  leaseToken: z.string().min(1).max(1024),
  expiresAt: z.number().positive(),
});

class CloudRejected extends Error {
  constructor(public status: number) {
    super("Cloud rejected connector request");
  }
}
export class Agent {
  private busy = false;
  constructor(
    private config: AgentConfig,
    private store: AgentStore,
    private runtime: RuntimeConnector,
    private token: string,
    private fetcher: typeof fetch = fetch,
    private readonly prepareCache = prepareReviewCache,
  ) {}
  private async post(
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data?: unknown }> {
    const combined = signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.requestTimeoutMs),
        ])
      : AbortSignal.timeout(this.config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(
        new URL(path, this.config.channel.baseUrl),
        {
          method: "POST",
          redirect: "error",
          signal: combined,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + this.token,
          },
          body: JSON.stringify(payload),
        },
      );
      if (response.status === 204) return { status: 204 };
      if (!response.ok) {
        await response.body?.cancel();
        throw new CloudRejected(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("Empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1000000) {
          await reader.cancel();
          throw Error("Response too large");
        }
        chunks.push(chunk.value);
      }
      return {
        status: response.status,
        data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
    } catch (e) {
      if (e instanceof CloudRejected) throw e;
      throw new AmbiguousExecution("Cloud request interrupted or invalid");
    }
  }
  private async report(signal?: AbortSignal): Promise<boolean> {
    const entry = this.store.pending();
    if (!entry) return false;
    try {
      const receipt = await this.post(
        "/connector/v2/tasks/" + entry.id + "/result",
        JSON.parse(entry.result!),
        signal,
      );
      if (
        receipt.status !== 200 ||
        !z
          .strictObject({ accepted: z.literal(true), duplicate: z.boolean() })
          .safeParse(receipt.data).success
      )
        throw new AmbiguousExecution("Cloud result acknowledgement is invalid");
      this.store.reported(entry.id);
    } catch (e) {
      // Expired/reconciled assignments are terminal locally; never rerun their model.
      if (e instanceof CloudRejected && e.status === 409)
        this.store.reported(entry.id);
      else throw e;
    }
    return true;
  }
  async once(signal?: AbortSignal): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      return await this.step(signal);
    } finally {
      this.busy = false;
    }
  }
  private async step(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (await this.report(signal)) return true;
    const claimed = await this.post(
      "/connector/v2/claim",
      { runtime: runtimeProfile(this.config.runtime) },
      signal,
    );
    if (claimed.status === 204) return false;
    const parsed = assignmentSchema.safeParse(claimed.data);
    if (!parsed.success) throw Error("Cloud assignment is invalid");
    const assignment = parsed.data as Assignment;
    if (!this.store.begin(assignment)) return false;
    let result: AgentResult = {
      leaseToken: assignment.leaseToken,
      status: "unknown",
    };
    const remaining = assignment.expiresAt - Date.now();
    if (remaining > 0 && !signal?.aborted) {
      const deadline = AbortSignal.timeout(
        Math.max(1, Math.min(remaining, this.config.runtime.timeoutMs)),
      );
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const task = assignment.task;
        const pin = task.target.kind === "pull_request" && task.target.revision;
        const runtime =
          this.runtime instanceof OpenClawConnector &&
          pin &&
          this.config.runtime.type === "openclaw" &&
          task.reviewPolicy?.deepReview
            ? this.runtime.withReviewSource(async () => {
                const dir = await this.prepareCache(
                  join(dirname(this.config.stateFile), "review-cache"),
                  task,
                  async () => {
                    const response = await this.post(
                      "/connector/v2/tasks/" + task.id + "/source-grant",
                      { leaseToken: assignment.leaseToken },
                      combined,
                    );
                    const grant = z
                      .strictObject({
                        token: z.string().min(1),
                        expiresAt: z.iso.datetime(),
                      })
                      .safeParse(response.data);
                    if (response.status !== 200 || !grant.success)
                      throw Error("Invalid review source grant");
                    return grant.data;
                  },
                  combined,
                );
                return openReviewSnapshot(
                  dir,
                  { fullName: task.owner + "/" + task.repo, sha: pin.headSha },
                  combined,
                );
              })
            : this.runtime;
        const output = await runtime.run(
          assignment.task,
          async (name, args) => {
            if (
              ![
                "read_issue",
                "read_file",
                "read_pull_diff",
                "review_access",
              ].includes(name)
            )
              throw new RuntimeFailure(
                "tool_call_invalid",
                "Unknown bridge tool",
              );
            if (combined.aborted)
              throw new AmbiguousExecution("Execution interrupted");
            const response = await this.post(
              "/connector/v2/tasks/" + assignment.task.id + "/tool",
              { leaseToken: assignment.leaseToken, name, args },
              combined,
            ).catch((error: unknown) => {
              if (error instanceof CloudRejected)
                throw new RuntimeFailure(
                  "tool_call_failed",
                  "Cloud rejected tool request",
                );
              throw error;
            });
            if (response.status !== 200)
              throw new AmbiguousExecution("Invalid tool acknowledgement");
            return response.data;
          },
          combined,
          async (event) => {
            const validated = runtimeEventSchema.parse(event);
            this.store.recordRuntime(assignment.task.id, validated);
            const receipt = await this.post(
              "/connector/v2/tasks/" + assignment.task.id + "/execution",
              { leaseToken: assignment.leaseToken, event: validated },
              combined,
            );
            if (receipt.status !== 200)
              throw new AmbiguousExecution(
                "Runtime receipt acknowledgement is invalid",
              );
          },
        );
        if (combined.aborted)
          throw new AmbiguousExecution("Execution interrupted");
        const validated = (() => {
          try {
            const valid = validateOutcome(output);
            validateTaskOutcome(assignment.task, valid);
            return valid;
          } catch {
            throw new RuntimeFailure(
              "runtime_response_invalid",
              "Invalid runtime outcome",
            );
          }
        })();
        result = {
          leaseToken: assignment.leaseToken,
          status: "succeeded",
          outcome: validated,
        };
      } catch (e) {
        const failure = signal?.aborted
          ? "runtime_interrupted"
          : deadline.aborted
            ? "runtime_timeout"
            : e instanceof AmbiguousExecution
              ? "runtime_transport"
              : e instanceof RuntimeFailure
                ? e.code
                : "runtime_failed";
        result = {
          leaseToken: assignment.leaseToken,
          status:
            e instanceof AmbiguousExecution || combined.aborted
              ? "unknown"
              : "failed",
          failure,
        };
      }
    }
    this.store.finish(assignment.task.id, result);
    if (!signal?.aborted) await this.report(signal);
    return true;
  }
}

export async function runAgent(
  configPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const { config, secrets } = loadAgentConfig(configPath);
  const store = new AgentStore(config.stateFile);
  const runtime = createRuntime(config.runtime, configPath, secrets.runtime);
  const agent = new Agent(config, store, runtime, secrets.channel);
  const stopInbox = new AbortController();
  const inboxSignal = signal
    ? AbortSignal.any([stopInbox.signal, signal])
    : stopInbox.signal;
  const inbox = runActivityInbox(
    config.stateFile,
    {
      baseUrl: config.channel.baseUrl,
      timeout: config.requestTimeoutMs,
      token: secrets.channel,
    },
    runtimeProfile(config.runtime),
    inboxSignal,
  ).catch(() => {
    console.error(JSON.stringify({ event: "activity_inbox_unavailable" }));
  });
  let failures = 0;
  try {
    while (!signal?.aborted) {
      try {
        await agent.once(signal);
        failures = 0;
      } catch (e) {
        if (signal?.aborted) break;
        if (!(e instanceof CloudRejected) && !(e instanceof AmbiguousExecution))
          throw Error(
            "Connector stopped after a journal or protocol failure; inspect local state before restart",
          );
        if (
          e instanceof CloudRejected &&
          (e.status === 401 || e.status === 403)
        )
          throw Error(
            "Connector authentication rejected; check the dedicated connector token and worker configuration",
          );
        failures = Math.min(failures + 1, 8);
        console.error(
          JSON.stringify({
            event: "connector_retry",
            category:
              e instanceof CloudRejected
                ? "cloud_http_rejected"
                : "cloud_connection_or_protocol",
            retryMs: Math.min(60000, config.pollIntervalMs * 2 ** failures),
          }),
        );
      }
      const pause = Math.min(60000, config.pollIntervalMs * 2 ** failures);
      try {
        await delay(pause, undefined, { signal });
      } catch {
        if (signal?.aborted) break;
        throw Error("Agent wait interrupted");
      }
    }
  } finally {
    stopInbox.abort();
    await inbox;
    store.close();
  }
}
