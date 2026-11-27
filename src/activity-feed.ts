import { z } from "zod";
import { targetSchema, revisionSchema, sourceSchema } from "./outcomes.js";
import { runtimeProfileSchema } from "./runtime-profile.js";

const id = z.number().int().positive().safe();
export const paginationSchema = z.strictObject({
  after: z.number().int().nonnegative().safe(),
  limit: z.number().int().min(1).max(100),
});
export const feedQueryFields = {
  ...paginationSchema.shape,
  runtime: runtimeProfileSchema,
};
const target = z.union([
  targetSchema,
  z.strictObject({
    kind: z.literal("pull_request"),
    number: id,
    revision: revisionSchema.optional(),
  }),
]);
const bindingId = z
  .string()
  .regex(/^[1-9]\d{0,15}:[1-9]\d{0,15}:[a-zA-Z0-9_-]{1,64}:[1-9]\d{0,15}$/);
export const receivedPageSchema = z.strictObject({
  bindingId,
  entries: z
    .array(
      z.strictObject({ cursor: id, deliveryId: z.string().min(1).max(100) }),
    )
    .min(1)
    .max(25)
    .refine(
      (rows) =>
        rows.every((row, i) => i === 0 || rows[i - 1].cursor < row.cursor) &&
        new Set(rows.map((row) => row.deliveryId)).size === rows.length,
    ),
});
const activity = z.strictObject({
  cursor: id,
  receivedAt: id,
  deliveryId: z.string().min(1),
  bindingId,
  installationId: id,
  repositoryId: id,
  owner: z.string(),
  repo: z.string(),
  actorLogin: z.string(),
  target,
  source: sourceSchema,
  reason: z.enum([
    "mention",
    "clarification_reply",
    "clarification_ambiguous",
    "clarification_unmatched",
    "clarification_pending",
    "triage",
    "label",
    "review",
    "observed",
    "self_receipt",
    "closed",
  ]),
  taskId: z.string().min(1).nullable(),
  excerpt: z.string().max(1024),
  truncated: z.boolean(),
});
export const activityPageSchema = z
  .strictObject({
    bindingId,
    activities: z.array(activity).max(100),
    nextCursor: paginationSchema.shape.after,
    hasMore: z.boolean(),
    truncated: z.boolean(),
  })
  .refine(
    (page) =>
      page.activities.every(
        (a) =>
          a.bindingId === page.bindingId &&
          a.bindingId.startsWith(a.installationId + ":" + a.repositoryId + ":"),
      ),
    "Activity scope differs from page binding",
  );
