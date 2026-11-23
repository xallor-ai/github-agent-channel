import { z } from "zod";
import type { RuntimeResult, Task } from "./contracts.js";

export const MAX_RESULT_BYTES = 2_000_000;
export const runtimeEventSchema = z.strictObject({
  kind: z.literal("started"),
  provider: z.string().min(1).max(100),
  runId: z.string().min(1).max(1024),
});
export const publicationReceiptSchema = z.strictObject({
  kind: z.enum(["comment", "pull_request"]),
  id: z.number().int().positive().safe().optional(),
  url: z.string().url().max(2048),
});
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
export const targetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("issue"),
    number: z.number().int().positive().safe(),
  }),
  z.strictObject({
    kind: z.literal("pull_request"),
    number: z.number().int().positive().safe(),
  }),
  z.strictObject({
    kind: z.literal("repository"),
    ref: z.string().min(1).max(1024).optional(),
    sha: sha.optional(),
  }),
]);
export const sourceSchema = z.strictObject({
  event: z.string().min(1).max(100),
  action: z.string().min(1).max(100).optional(),
  commentId: z.number().int().positive().safe().optional(),
});
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !/[\\\x00-\x1f:]/.test(p) &&
      !p.startsWith("/") &&
      p
        .split("/")
        .every(
          (s) =>
            s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git",
        ),
    "Unsafe repository path",
  );
const files = z
  .array(z.strictObject({ path, content: z.string().max(524288).nullable() }))
  .min(1)
  .max(100)
  .refine(
    (fs) => new Set(fs.map((f) => f.path.toLowerCase())).size === fs.length,
    "Duplicate paths",
  )
  .refine(
    (fs) =>
      fs.reduce((n, f) => n + Buffer.byteLength(f.content ?? ""), 0) <= 524288,
    "Change set too large",
  );
const name = z.string().min(1).max(200);
const artifactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    name,
    text: z.string().max(18000),
  }),
  z.strictObject({
    kind: z.literal("link"),
    name,
    url: z
      .string()
      .max(2048)
      .url()
      .refine((s) => {
        const u = new URL(s);
        return u.protocol === "https:" && !u.username && !u.password;
      }),
  }),
  z.strictObject({
    kind: z.literal("test_report"),
    name,
    command: z.string().max(2000),
    exitCode: z.number().int().nullable(),
    summary: z.string().max(18000),
  }),
  z.strictObject({ kind: z.literal("change_set"), name, baseSha: sha, files }),
]);
const publicationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("comment") }),
  z.strictObject({
    kind: z.literal("pull_request"),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(18000),
    baseBranch: z.string().min(1).max(200),
    baseSha: sha,
    files,
  }),
]);
const outcomeShape = {
  text: z.string().max(18000),
  responseId: z.string().min(1).max(1024).optional(),
  artifacts: z.array(artifactSchema).max(10),
  publication: publicationSchema,
};
export const outcomeSchema = z
  .strictObject(outcomeShape)
  .superRefine((o, ctx) => {
    if (!o.text.trim() && !o.artifacts?.length)
      ctx.addIssue({
        code: "custom",
        message: "An outcome requires text or artifacts",
      });
    if (Buffer.byteLength(JSON.stringify(o)) > MAX_RESULT_BYTES - 4096)
      ctx.addIssue({ code: "custom", message: "Outcome too large" });
  });
export function validateOutcome(value: unknown): RuntimeResult {
  return outcomeSchema.parse(value);
}
export function validateTaskOutcome(task: Task, outcome: RuntimeResult): void {
  const publication = outcome.publication;
  if (
    publication.kind === "comment" &&
    (task.target.kind === "repository" || !outcome.text.trim())
  )
    throw Error("Comment publication requires issue target and text");
}
