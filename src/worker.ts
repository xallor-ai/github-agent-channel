import { AccessDenied, type GitHubClient } from "./contracts.js";
import { noticeFailureCode } from "./runtime-failure.js";
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
        if (delivery.status === "failed") {
          const code = noticeFailureCode(delivery.error);
          if (!code || delivery.target.kind === "repository")
            throw new AccessDenied("No failure notice requested");
          const result = await this.github.publishComment(
            delivery,
            code === "review_diff_unavailable" &&
              delivery.target.kind === "pull_request" &&
              delivery.target.revision
              ? `代码评审未完成：没有取得本次提交的可用差异。base ${delivery.target.revision.baseSha}，head ${delivery.target.revision.headSha}。本通知不是评审结论。任务 ID：${delivery.id}`
              : `本次任务未生成可发布的分析。原因：\`${code}\`。维护者可按任务 ID ${delivery.id} 查看执行记录。`,
          );
          this.store.markDelivery(delivery.id, "sent", {
            kind: "comment",
            ...result,
          });
          return true;
        }
        if (!delivery.outcome) throw Error("Missing publication outcome");
        const publication = delivery.outcome.publication;
        let result: { id: number; url: string };
        switch (publication.kind) {
          case "none":
            throw new AccessDenied("No publication requested");
          case "review":
            if (!this.github.publishReview)
              throw new AccessDenied("Native reviews unavailable");
            result = await this.github.publishReview(
              delivery,
              delivery.outcome.text,
            );
            break;
          case "pull_request":
            result = await this.github.publishPullRequest(
              delivery,
              publication,
            );
            break;
          case "comment":
            result = await this.github.publishComment(
              delivery,
              delivery.outcome.text,
            );
            break;
        }
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
