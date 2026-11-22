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
        await this.github.authorize(delivery);
        const result = await this.github.publish(delivery, delivery.result!);
        this.store.markDelivery(delivery.id, "sent", result.url);
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
