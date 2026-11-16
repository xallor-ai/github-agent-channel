import { z } from "zod";
import {
  AccessDenied,
  AmbiguousExecution,
  type GitHubClient,
  type RuntimeConnector,
} from "./contracts.js";
import { TaskStore } from "./store.js";

export class Worker {
  private busy = false;
  constructor(
    private store: TaskStore,
    private github: GitHubClient,
    private runtime: RuntimeConnector,
  ) {}
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const delivery = this.store.pendingDelivery();
      if (delivery) {
        try {
          await this.github.authorize(delivery);
          const result = await this.github.publish(delivery, delivery.result!);
          this.store.markDelivery(delivery.id, "sent", result.url);
        } catch (e) {
          this.store.markDelivery(
            delivery.id,
            e instanceof AccessDenied ? "failed" : "unknown",
          );
        }
        return true;
      }
      const task = this.store.claim();
      if (!task) return false;
      try {
        await this.github.authorize(task);
        const result = await this.runtime.run(task, async (name, args) => {
          await this.github.authorize(task);
          if (name === "read_issue") {
            z.strictObject({}).parse(args);
            return this.github.readIssue(task);
          }
          if (name === "read_file") {
            const input = z
              .strictObject({ path: z.string().min(1).max(1024) })
              .parse(args);
            return this.github.readFile(task, input.path);
          }
          throw new Error("Unsupported task tool");
        });
        if (!result.text.trim() || result.text.length > 18000)
          throw new Error("Invalid final result");
        this.store.finish(
          task.id,
          "succeeded",
          result.text,
          undefined,
          result.responseId,
        );
      } catch (e) {
        const status =
          e instanceof AccessDenied
            ? "rejected"
            : e instanceof AmbiguousExecution
              ? "unknown"
              : "failed";
        // Error text from providers can contain credentials or source text; store only a bounded category.
        this.store.finish(
          task.id,
          status,
          undefined,
          status === "unknown"
            ? "Runtime execution requires reconciliation"
            : status === "rejected"
              ? "Task authorization denied"
              : "Task execution failed",
        );
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}
