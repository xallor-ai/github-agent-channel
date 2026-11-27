import type { RuntimeProfile } from "../src/runtime-profile.js";
import type { TaskStore } from "../src/store.js";
import type { Binding } from "../src/contracts.js";

export const fixtureAgent = {
  type: "openclaw",
  id: "github",
  deepReview: true,
  nativeReview: true,
} as const;

export function seedBinding(
  store: TaskStore,
  target: Pick<
    Binding,
    "installationId" | "repositoryId" | "owner" | "repo"
  > & { bindingId?: string },
  deviceId: string,
  events: string[] = ["issue_comment.created"],
  responsibleAgent: RuntimeProfile = fixtureAgent,
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
      responsibleAgent,
      events,
      ...(events.includes("issues.labeled") ? { triggerLabel: "agent" } : {}),
    },
  );
  return store.activeBinding(installationId, repositoryId)!;
}
