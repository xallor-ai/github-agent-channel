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
  if (headers.event !== "issue_comment") return null;
  const event = JSON.parse(payload);
  if (!event || event.action !== "created") return null;
  const { installation, repository, sender, comment, issue } = event;
  if (
    sender?.type !== "User" ||
    comment?.user?.type !== "User" ||
    sender.login === config.github.botLogin ||
    /\[bot\]$/i.test(sender.login ?? "")
  )
    return null;
  if (
    typeof sender.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(sender.login) ||
    sender.id !== comment.user.id ||
    sender.login !== comment.user.login
  )
    return null;
  if (
    ![
      installation?.id,
      repository?.id,
      sender.id,
      comment.id,
      issue?.number,
    ].every(positive)
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
  if (
    !binding ||
    typeof comment.body !== "string" ||
    comment.body.length > 16000
  )
    return null;
  const escaped = config.github.botLogin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    !new RegExp(
      `(?<![A-Za-z0-9_@-])@${escaped}(?![A-Za-z0-9_\\[\\]-])`,
      "i",
    ).test(comment.body)
  )
    return null;
  return {
    deliveryId: headers.delivery,
    commentId: comment.id,
    bindingId: binding.id,
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    owner: binding.owner,
    repo: binding.repo,
    actorId: sender.id,
    actorLogin: sender.login,
    issueNumber: issue.number,
    prompt: comment.body,
  };
}
