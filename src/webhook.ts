import { Webhooks } from "@octokit/webhooks";
import type { ChannelConfig, NewTask } from "./contracts.js";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export async function normalizeWebhook(
  config: ChannelConfig,
  raw: Buffer,
  headers: { signature: string; delivery: string; event: string },
  secret: string,
): Promise<NewTask | null> {
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
    headers.delivery.length > 128 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      headers.delivery,
    )
  )
    throw new Error("Invalid delivery ID");
  if (
    !["issue_comment", "issues", "pull_request", "push"].includes(headers.event)
  )
    return null;
  const event = JSON.parse(payload);
  if (!event || typeof event !== "object") return null;
  const { installation, repository, sender } = event;
  if (
    sender?.type !== "User" ||
    typeof sender.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(sender.login) ||
    sender.login === config.github.botLogin ||
    ![installation?.id, repository?.id, sender.id].every(positive)
  )
    return null;
  const binding = config.bindings.find(
    (b) =>
      b.enabled &&
      b.installationId === installation.id &&
      b.repositoryId === repository.id &&
      b.owner === repository.owner?.login &&
      b.repo === repository.name,
  );
  if (!binding) return null;
  const key =
    headers.event === "push" ? "push" : headers.event + "." + event.action;
  if (!(binding.events ?? ["issue_comment.created"]).includes(key)) return null;
  const mentions = [config.github.botLogin];
  if (/\[bot\]$/i.test(config.github.botLogin))
    mentions.push(config.github.botLogin.replace(/\[bot\]$/i, ""));
  const escaped = mentions
    .map((name) => name.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"))
    .join("|");
  const mentioned = (text: string) =>
    new RegExp(
      "(?<![A-Za-z0-9_@-])@(?:" + escaped + ")(?![A-Za-z0-9_\\[\\]-])",
      "i",
    ).test(text);
  const task: Omit<NewTask, "target"> = {
    deliveryId: headers.delivery,
    bindingId: binding.id,
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    owner: binding.owner,
    repo: binding.repo,
    actorId: sender.id,
    actorLogin: sender.login,
    prompt: "",
    source: {
      event: headers.event,
      ...(typeof event.action === "string" ? { action: event.action } : {}),
    },
  };
  if (headers.event === "issue_comment") {
    const { comment, issue } = event;
    if (
      !positive(comment?.id) ||
      !positive(issue?.number) ||
      comment.user?.type !== "User" ||
      comment.user.id !== sender.id ||
      comment.user.login !== sender.login ||
      typeof comment.body !== "string" ||
      comment.body.length > 16000 ||
      !mentioned(comment.body)
    )
      return null;
    return {
      ...task,
      source: { ...task.source, commentId: comment.id },
      prompt: comment.body,
      target: {
        kind: issue.pull_request ? "pull_request" : "issue",
        number: issue.number,
      },
    };
  }
  if (headers.event === "push") {
    if (
      event.deleted ||
      typeof event.ref !== "string" ||
      !/^refs\/heads\/[^\s\x00-\x1f]{1,240}$/.test(event.ref) ||
      typeof event.after !== "string" ||
      !/^[0-9a-f]{40}$/i.test(event.after) ||
      /^0+$/.test(event.after)
    )
      return null;
    return {
      ...task,
      prompt: "Repository push\nRef: " + event.ref + "\nCommit: " + event.after,
      target: { kind: "repository", ref: event.ref, sha: event.after },
    };
  }
  const item = headers.event === "issues" ? event.issue : event.pull_request;
  if (
    !positive(item?.number) ||
    typeof item.title !== "string" ||
    item.title.length > 500 ||
    (item.body !== null &&
      item.body !== undefined &&
      typeof item.body !== "string")
  )
    return null;
  const body = item.body ?? "";
  if (body.length > 15000) return null;
  if (key === "issues.opened" && !mentioned(body + "\n" + item.title))
    return null;
  if (
    key === "issues.labeled" &&
    (!binding.triggerLabel || event.label?.name !== binding.triggerLabel)
  )
    return null;
  return {
    ...task,
    prompt: item.title + "\n\n" + body,
    target: {
      kind: headers.event === "issues" ? "issue" : "pull_request",
      number: item.number,
    },
  };
}
