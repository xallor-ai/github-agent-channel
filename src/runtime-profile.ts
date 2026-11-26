import { z } from "zod";
import type { AgentConfig } from "./agent-config.js";

// Public identity and adapter capabilities only. Never include endpoints, paths,
// command arguments, credentials, or transient runtime availability here.
export const agentName = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/);
export const runtimeProfileSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("openclaw"),
    id: agentName,
    deepReview: z.boolean(),
    nativeReview: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("acp"),
    id: agentName,
    deepReview: z.literal(false),
    nativeReview: z.literal(false),
  }),
]);
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export function runtimeProfile(
  runtime: AgentConfig["runtime"],
): RuntimeProfile {
  return runtime.type === "openclaw"
    ? {
        type: "openclaw",
        id: runtime.agentId,
        deepReview: true,
        nativeReview: true,
      }
    : {
        type: "acp",
        id: runtime.agentId,
        deepReview: false,
        nativeReview: false,
      };
}
export function sameRuntimeIdentity(
  a: RuntimeProfile,
  b: RuntimeProfile,
): boolean {
  return a.type === b.type && a.id === b.id;
}
