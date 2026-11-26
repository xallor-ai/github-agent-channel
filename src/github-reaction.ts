import type { Octokit } from "@octokit/core";
import { AccessDenied, AmbiguousExecution, type Task } from "./contracts.js";

export type ReactionFailure =
  | "scope"
  | "forbidden"
  | "rate_limited"
  | "comment_unavailable"
  | "unavailable"
  | "unconfirmed";
export class ReactionRejected extends Error {
  constructor(readonly reason: ReactionFailure) {
    super(reason);
  }
}
function status(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? error.status
    : null;
}
export function reactionFailure(error: unknown): ReactionFailure {
  if (error instanceof ReactionRejected) return error.reason;
  if (error instanceof AccessDenied) return "scope";
  if (error instanceof AmbiguousExecution) return "unconfirmed";
  const code = status(error);
  const response =
    error && typeof error === "object" && "response" in error
      ? error.response
      : null;
  const headers =
    response && typeof response === "object" && "headers" in response
      ? response.headers
      : null;
  if (
    code === 429 ||
    (code === 403 &&
      headers &&
      typeof headers === "object" &&
      ("retry-after" in headers ||
        ("x-ratelimit-remaining" in headers &&
          headers["x-ratelimit-remaining"] === "0")))
  )
    return "rate_limited";
  if (code === 403 || code === 401) return "forbidden";
  return "unavailable";
}
const validId = (id: unknown): id is number =>
  typeof id === "number" && Number.isSafeInteger(id) && id > 0;
export async function ownerReaction(
  client: Octokit,
  task: Task,
  botLogin: string,
  authorizeWrite: (() => Promise<void>) | undefined,
  check: () => void,
): Promise<number | null> {
  const target = task.target,
    comment_id = task.source.commentId;
  if (
    target.kind === "repository" ||
    !validId(target.number) ||
    !validId(comment_id) ||
    task.source.event !== "issue_comment" ||
    task.source.action !== "created" ||
    task.actorLogin === botLogin
  )
    throw new AccessDenied("Missing original human comment");
  const scope = { owner: task.owner, repo: task.repo };
  const params = { ...scope, comment_id };
  const mine = (r: {
    id: number;
    content: string;
    user: { login: string; type: string } | null;
  }) =>
    validId(r.id) &&
    r.content === "eyes" &&
    r.user?.type === "Bot" &&
    r.user.login === botLogin;
  const verifyComment = async () => {
    const { data: c } = await client
      .request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", params)
      .catch((e: unknown) => {
        if (status(e) === 404)
          throw new ReactionRejected("comment_unavailable");
        throw e;
      });
    if (
      c.id !== comment_id ||
      c.user?.type !== "User" ||
      c.user.id !== task.actorId ||
      c.user.login !== task.actorLogin ||
      c.issue_url !==
        "https://api.github.com/repos/" +
          scope.owner +
          "/" +
          scope.repo +
          "/issues/" +
          target.number
    )
      throw new AccessDenied("Original comment identity changed");
  };
  await verifyComment();
  if (!authorizeWrite) {
    let observed: number | null = null;
    for (let page = 1; page <= 10; page++) {
      check();
      const { data, headers } = await client.request(
        "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
        {
          ...params,
          content: "eyes",
          per_page: 100,
          page,
        },
      );
      check();
      for (const row of data.filter(mine)) {
        if (observed !== null && observed !== row.id)
          throw new AmbiguousExecution("Multiple matching reactions");
        observed = row.id;
      }
      if (!headers.link?.includes('rel="next"') && data.length < 100)
        return observed;
    }
    throw Error("Reaction lookup limit reached");
  }
  await authorizeWrite();
  if (target.kind === "issue") {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { ...scope, issue_number: target.number },
    );
    if (
      data.number !== target.number ||
      data.state !== "open" ||
      data.pull_request
    )
      throw new AccessDenied("Issue is not open");
  } else {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { ...scope, pull_number: target.number },
    );
    if (
      data.number !== target.number ||
      data.state !== "open" ||
      data.merged !== false ||
      data.head.repo?.id !== task.repositoryId ||
      data.base.repo?.id !== task.repositoryId
    )
      throw new AccessDenied("PR is not open in this repository");
  }
  check();
  try {
    const { status: code, data } = await client.request(
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      { ...params, content: "eyes" },
    );
    if ((code !== 200 && code !== 201) || !mine(data))
      throw new AmbiguousExecution("Unverified reaction");
    return data.id;
  } catch (e) {
    const code = status(e);
    if (code === 404) throw new ReactionRejected("comment_unavailable");
    if (typeof code === "number" && code >= 400 && code < 500 && code !== 408)
      throw new ReactionRejected(reactionFailure(e));
    throw new AmbiguousExecution("Reaction dispatch unconfirmed");
  }
}
