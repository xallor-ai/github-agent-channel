import type { TaskStore } from "../src/store.js";
import type { Binding } from "../src/contracts.js";

export function seedBinding(
  store: TaskStore,
  target: Pick<
    Binding,
    "installationId" | "repositoryId" | "owner" | "repo"
  > & { bindingId?: string },
  deviceId: string,
  events: string[] = ["issue_comment.created"],
) {
  const { installationId, repositoryId, owner, repo } = target;
  store.registry.apply(
    {
      installationId,
      repositoryId,
      owner,
      repo,
      deviceId,
      administratorId: 44,
    },
    0,
    {
      enabled: true,
      events,
      ...(events.includes("issues.labeled") ? { triggerLabel: "agent" } : {}),
    },
  );
  return store.activeBinding(installationId, repositoryId)!;
}
