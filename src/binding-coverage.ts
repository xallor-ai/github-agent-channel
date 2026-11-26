import { z } from "zod";
import { bindingEvent } from "./binding-events.js";

const subscriptions = z.array(z.string().regex(/^[a-z_0-9]{1,80}$/)).max(512);
const permission = z.enum(["read", "write", "admin", "none"]);
const relevantPermissions = z.object({
  issues: permission.optional(),
  pull_requests: permission.optional(),
  contents: permission.optional(),
});
export const coverageSchema = z.strictObject({
  runtimePoll: z.union([
    z.strictObject({
      status: z.enum(["unbound", "unknown", "never_seen"]),
      lastPolledAt: z.null(),
    }),
    z.strictObject({
      status: z.enum(["recent", "last_seen"]),
      lastPolledAt: z.number().int().nonnegative().safe(),
    }),
  ]),
  subscriptions: subscriptions.nullable(),
  permissions: relevantPermissions.nullable(),
  serverWriteProfile: z.boolean().nullable(),
});
export function installationEvidence(installation: {
  events?: unknown;
  permissions?: unknown;
}) {
  const events = subscriptions.safeParse(installation.events);
  const permissions = relevantPermissions.safeParse(installation.permissions);
  return {
    subscriptions: events.success ? events.data : null,
    permissions: permissions.success ? permissions.data : null,
  };
}

// https://docs.github.com/en/webhooks/webhook-events-and-payloads
const requiredPermission = {
  issues: "issues",
  issue_comment: "issues",
  pull_request: "pull_requests",
  push: "contents",
} as const;
export function eventCoverage(
  filter: z.infer<typeof bindingEvent>[],
  coverage: z.infer<typeof coverageSchema>,
) {
  return filter.map((event) => {
    const family = event.split(".")[0];
    const permission =
      requiredPermission[family as keyof typeof requiredPermission];
    const subscribed = coverage.subscriptions?.includes(family);
    const level = permission && coverage.permissions?.[permission];
    const hasPermission =
      coverage.permissions && permission
        ? !!level && level !== "none"
        : undefined;
    return {
      event,
      subscription: subscribed ?? "unknown",
      permission: hasPermission ?? "unknown",
      eligible:
        subscribed === false || hasPermission === false
          ? false
          : subscribed && hasPermission
            ? true
            : "unknown",
    };
  });
}
