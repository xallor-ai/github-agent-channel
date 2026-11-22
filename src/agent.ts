import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { OpenClawConnector } from "./connector.js";
import {
  AmbiguousExecution,
  type RuntimeConnector,
  type Task,
} from "./contracts.js";
import {
  loadAgentConfig,
  agentSecrets,
  type AgentConfig,
} from "./agent-config.js";
import {
  AgentStore,
  type Assignment,
  type AgentResult,
} from "./agent-store.js";

const uuid = z.string().uuid();
const assignmentSchema = z.strictObject({
  task: z
    .object({
      id: uuid,
      prompt: z.string().max(16000),
      deliveryId: z.string(),
      commentId: z.number().int().positive(),
      bindingId: z.string(),
      installationId: z.number().int().positive(),
      repositoryId: z.number().int().positive(),
      owner: z.string(),
      repo: z.string(),
      actorId: z.number().int().positive(),
      actorLogin: z.string(),
      issueNumber: z.number().int().positive(),
      status: z.literal("running"),
      deliveryStatus: z.enum([
        "pending",
        "sending",
        "sent",
        "failed",
        "unknown",
      ]),
      result: z.string().nullable(),
      error: z.string().nullable(),
      createdAt: z.number(),
      responseId: z.string().nullable(),
      commentUrl: z.string().nullable(),
    })
    .passthrough(),
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
        "/connector/v1/tasks/" + entry.id + "/result",
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
    const claimed = await this.post("/connector/v1/claim", {}, signal);
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
        const output = await this.runtime.run(
          assignment.task,
          async (name, args) => {
            if (combined.aborted)
              throw new AmbiguousExecution("Execution interrupted");
            const response = await this.post(
              "/connector/v1/tasks/" + assignment.task.id + "/tool",
              { leaseToken: assignment.leaseToken, name, args },
              combined,
            );
            if (response.status !== 200)
              throw new AmbiguousExecution("Invalid tool acknowledgement");
            return response.data;
          },
          combined,
        );
        if (combined.aborted)
          throw new AmbiguousExecution("Execution interrupted");
        if (
          !output.text.trim() ||
          output.text.length > 18000 ||
          (output.responseId && output.responseId.length > 1024)
        )
          throw Error("Invalid model result");
        result = {
          leaseToken: assignment.leaseToken,
          status: "succeeded",
          text: output.text,
          ...(output.responseId ? { responseId: output.responseId } : {}),
        };
      } catch (e) {
        result = {
          leaseToken: assignment.leaseToken,
          status:
            e instanceof AmbiguousExecution || combined.aborted
              ? "unknown"
              : "failed",
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
  const config = loadAgentConfig(configPath);
  const secrets = agentSecrets(config, configPath);
  const store = new AgentStore(config.stateFile);
  const runtime = new OpenClawConnector(config.runtime, secrets.runtime);
  const agent = new Agent(config, store, runtime, secrets.channel);
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
    store.close();
  }
}
