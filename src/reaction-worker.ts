import {
  AccessDenied,
  AmbiguousExecution,
  type GitHubClient,
} from "./contracts.js";
import { reactionFailure } from "./github-reaction.js";
import type { TaskStore } from "./store.js";

export class ReactionWorker {
  private busy = false;
  constructor(
    private readonly store: Pick<
      TaskStore,
      "reserveReaction" | "finishReaction" | "reactionAllowed"
    >,
    private readonly github: Pick<
      GitHubClient,
      "publishOwnerReaction" | "lookupOwnerReaction"
    >,
  ) {}
  async tick(): Promise<boolean> {
    if (this.busy || !this.github.publishOwnerReaction) return false;
    this.busy = true;
    try {
      const task = this.store.reserveReaction();
      if (!task) return false;
      const check = () => {
        if (!this.store.reactionAllowed(task.id))
          throw new AccessDenied("Owner receipt scope no longer active");
      };
      let result: Parameters<TaskStore["finishReaction"]>[1];
      try {
        check();
        const reactionId = await this.github.publishOwnerReaction(task, check);
        result = { status: "sent", reactionId };
      } catch (e) {
        if (e instanceof AmbiguousExecution) {
          // One read-only recovery attempt. Absence (or a failed lookup) is
          // not proof the POST failed. Never enqueue another POST on this path.
          result = { status: "unknown", reason: "unconfirmed" };
          try {
            const id = await this.github.lookupOwnerReaction?.(task);
            if (id) result = { status: "sent", reactionId: id };
          } catch (lookupError) {
            const { reason, retryAt } = reactionFailure(lookupError);
            if (reason === "rate_limited")
              result = {
                status: "unknown",
                reason: "lookup_rate_limited",
                retryAt,
              };
          }
        } else {
          const { reason, retryAt } = reactionFailure(e);
          result = {
            status: "failed",
            reason,
            ...(retryAt !== undefined && { retryAt }),
          };
        }
      }
      this.store.finishReaction(task.id, result);
      return true;
    } finally {
      this.busy = false;
    }
  }
}
