import { AccessDenied, type GitHubClient } from "./contracts.js";
import { TaskStore } from "./store.js";

/** Cloud-side publication only. Agent execution belongs to the outbound client. */
export class DeliveryWorker {
  private busy = false;
  constructor(
    private readonly store: TaskStore,
    private readonly github: GitHubClient,
  ) {}
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const delivery = this.store.pendingDelivery();
      if (!delivery) return false;
      try {
        try {
          await this.github.authorize(delivery);
        } catch {
          // No publication call has been made. Do not block the queue as an unknown write.
          this.store.markDelivery(delivery.id, "failed");
          return true;
        }
        // Authorization may have awaited GitHub while this binding was disabled.
        if (
          this.store.activeBinding(
            delivery.installationId,
            delivery.repositoryId,
          )?.id !== delivery.bindingId
        )
          throw new AccessDenied("Binding changed before publication");
        if (!delivery.outcome) throw Error("Missing publication outcome");
        const publication = delivery.outcome.publication;
        if (publication.kind === "none")
          throw new AccessDenied("No publication requested");
        const result =
          publication.kind === "pull_request"
            ? await this.github.publishPullRequest(delivery, publication)
            : await this.github.publishComment(delivery, delivery.outcome.text);
        this.store.markDelivery(delivery.id, "sent", {
          kind: publication.kind,
          ...result,
        });
      } catch (error) {
        this.store.markDelivery(
          delivery.id,
          error instanceof AccessDenied ? "failed" : "unknown",
        );
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}
