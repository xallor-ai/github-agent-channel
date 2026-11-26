import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import { bindingEvent } from "./binding-events.js";
import type { BindingLookup, NewTask } from "./contracts.js";
import { revisionSchema } from "./outcomes.js";

type ActionReason = "mention" | "triage" | "label" | "review";
type ObservationReason = "observed" | "self_receipt" | "closed";
export type WebhookDecision =
  | { githubTime?: number; input: NewTask; execute: true; reason: ActionReason }
  | {
      githubTime?: number;
      input: NewTask;
      execute: false;
      reason: ObservationReason;
    };

const id = z.number().int().positive().safe();
const actor = z.object({
  type: z.enum(["User", "Bot"]),
  login: z.string(),
  id,
});
// GitHub emits UTC instants in signed payloads. No receipt-time fallback: retries can arrive out of order.
function githubTime(raw: unknown) {
  const parsed = z.iso.datetime().safeParse(raw);
  if (!parsed.success) return undefined;
  const ms = Date.parse(parsed.data);
  return Number.isSafeInteger(ms) ? ms : undefined;
}
const issue = z.object({
  closed_at: z.unknown().optional(),
  number: id,
  state: z.enum(["open", "closed"]),
  pull_request: z.object({}).optional(),
});
const item = issue.extend({
  created_at: z.unknown().optional(),
  updated_at: z.unknown().optional(),
  title: z.string().min(1).max(500),
  body: z.string().nullable(),
});
const ref = z.object({
  sha: revisionSchema.shape.headSha,
  repo: z.object({ id }).nullable(),
});
const pr = item.extend({ base: ref, head: ref });
const envelope = z.object({
  sender: actor,
  installation: z.object({ id }),
  repository: z.object({
    id,
    owner: z.object({ login: z.string() }),
    name: z.string(),
  }),
  action: z.string().optional(),
});
const comment = z.object({
  id,
  created_at: z.unknown().optional(),
  body: z.string().min(1),
  user: actor,
});
const push = z.object({
  ref: z.string().regex(/^refs\/heads\/[^\s\x00-\x1f]{1,240}$/),
  after: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .refine((s) => !/^0+$/.test(s)),
  deleted: z.literal(false),
});

function observation(
  input: NewTask,
  reason: ObservationReason = "observed",
  time?: unknown,
): WebhookDecision {
  return {
    input,
    githubTime: githubTime(time),
    execute: false,
    reason,
  };
}
function action(
  input: NewTask,
  reason: ActionReason,
  time: unknown,
): WebhookDecision {
  return {
    input,
    execute: true,
    reason,
    githubTime: githubTime(time),
  };
}
function mentionsBot(body: string, login: string) {
  const aliases = [login, login.replace(/\[bot\]$/i, "")];
  const escaped = aliases
    .map((s) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"))
    .join("|");
  return new RegExp(
    "(?<![A-Za-z0-9_@-])@(?:" + escaped + ")(?![A-Za-z0-9_\\[\\]-])",
    "i",
  ).test(body);
}

export async function normalizeWebhook(
  config: { github: { botLogin: string }; lookup: BindingLookup },
  raw: Buffer,
  headers: { signature: string; delivery: string; event: string },
  secret: string,
): Promise<WebhookDecision | null> {
  // Fatal decoding ensures the SDK's string API verifies exactly the received UTF-8 bytes.
  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    throw new Error("Invalid webhook signature payload");
  }
  if (!(await new Webhooks({ secret }).verify(payload, headers.signature)))
    throw new Error("Invalid webhook signature");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      headers.delivery,
    )
  )
    throw new Error("Invalid delivery ID");
  if (
    !["issue_comment", "issues", "pull_request", "push"].includes(headers.event)
  )
    return null;
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = envelope.safeParse(event);
  if (!parsed.success) return null;
  const { sender, installation, repository, action: eventAction } = parsed.data;
  const key =
    headers.event === "push" ? "push" : headers.event + "." + eventAction;
  if (
    !bindingEvent.safeParse(key).success ||
    (key === "push" && eventAction !== undefined)
  )
    return null;
  const isSelf =
    sender.login.toLowerCase() === config.github.botLogin.toLowerCase();
  if (
    isSelf
      ? key !== "issue_comment.created" || sender.type !== "Bot"
      : sender.type !== "User" || !/^[A-Za-z0-9-]{1,39}$/.test(sender.login)
  )
    return null;
  const binding = config.lookup(installation.id, repository.id);
  if (
    !binding?.enabled ||
    !binding.events.includes(key) ||
    binding.installationId !== installation.id ||
    binding.repositoryId !== repository.id ||
    binding.owner !== repository.owner.login ||
    binding.repo !== repository.name
  )
    return null;
  const scope = {
    deliveryId: headers.delivery,
    bindingId: binding.id,
    installationId: installation.id,
    repositoryId: repository.id,
    owner: binding.owner,
    repo: binding.repo,
    actorId: sender.id,
    actorLogin: sender.login,
    source: {
      event: headers.event,
      ...(eventAction ? { action: eventAction } : {}),
    },
  };
  if (key === "issue_comment.created") {
    const value = z.object({ issue, comment }).safeParse(event);
    if (!value.success) return null;
    const {
      issue: target,
      comment: { id, body, user },
    } = value.data;
    if (
      user.type !== sender.type ||
      user.id !== sender.id ||
      user.login !== sender.login ||
      !body.trim()
    )
      return null;
    const input: NewTask = {
      ...scope,
      prompt: body,
      source: { ...scope.source, commentId: id },
      target: {
        kind: target.pull_request ? "pull_request" : "issue",
        number: target.number,
      },
    };
    if (isSelf) return observation(input, "self_receipt");
    if (target.state === "closed")
      return observation(input, "closed", target.closed_at);
    if (body.length > 16000 || !mentionsBot(body, config.github.botLogin))
      return observation(input);
    return action(input, "mention", value.data.comment.created_at);
  }
  if (key === "push") {
    const value = push.safeParse(event);
    if (!value.success) return null;
    const { ref, after } = value.data;
    return observation({
      ...scope,
      prompt: "Repository push\nRef: " + ref + "\nCommit: " + after,
      target: { kind: "repository", ref, sha: after },
    });
  }
  if (headers.event === "issues") {
    const value = z
      .object({
        issue: item,
        label: z.object({ name: z.string().min(1) }).optional(),
      })
      .safeParse(event);
    if (!value.success) return null;
    const { issue: target, label } = value.data;
    if (
      target.pull_request ||
      (key === "issues.closed" && target.state !== "closed") ||
      (key === "issues.opened" && target.state !== "open") ||
      (key === "issues.labeled" && !label)
    )
      return null;
    const input: NewTask = {
      ...scope,
      prompt: target.title + "\n\n" + (target.body ?? ""),
      target: { kind: "issue", number: target.number },
    };
    if (target.state === "closed")
      return observation(input, "closed", target.closed_at);
    if ((target.body?.length ?? 0) > 15000) return observation(input);
    if (key === "issues.labeled")
      return binding.triggerLabel && label?.name === binding.triggerLabel
        ? action(input, "label", target.updated_at)
        : observation(input);
    if (key !== "issues.opened") return observation(input);
    if (mentionsBot(input.prompt, config.github.botLogin))
      return action(input, "mention", target.created_at);
    return binding.autoTriage
      ? action(input, "triage", target.created_at)
      : observation(input);
  }
  const value = z.object({ pull_request: pr }).safeParse(event);
  if (!value.success) return null;
  const target = value.data.pull_request;
  if (
    target.base.repo?.id !== repository.id ||
    (key === "pull_request.closed") !== (target.state === "closed")
  )
    return null;
  const revision = revisionSchema.safeParse({
    baseSha: target.base.sha,
    headSha: target.head.sha,
    baseRepoId: target.base.repo.id,
    headRepoId: target.head.repo?.id,
  });
  if (
    !revision.success &&
    !(target.state === "closed" && target.head.repo === null)
  )
    return null;
  const input: NewTask = {
    ...scope,
    prompt: target.title + "\n\n" + (target.body ?? ""),
    target: {
      kind: "pull_request",
      number: target.number,
      ...(revision.success ? { revision: revision.data } : {}),
    },
  };
  if (target.state === "closed")
    return observation(input, "closed", target.closed_at);
  return (key === "pull_request.opened" ||
    key === "pull_request.synchronize") &&
    binding.autoReview &&
    (target.body?.length ?? 0) <= 15000
    ? action(
        input,
        "review",
        key === "pull_request.opened" ? target.created_at : target.updated_at,
      )
    : observation(input);
}
