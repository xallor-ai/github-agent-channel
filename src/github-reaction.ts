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
  constructor(
    readonly reason: ReactionFailure,
    readonly retryAt?: number,
  ) {
    super(reason);
  }
}
function status(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? error.status
    : null;
}
function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : {};
}
export function reactionFailure(error: unknown): ReactionRejected {
  if (error instanceof ReactionRejected) return error;
  if (error instanceof AccessDenied) return new ReactionRejected("scope");
  if (error instanceof AmbiguousExecution)
    return new ReactionRejected("unconfirmed");
  const code = status(error);
  const response = record(record(error).response);
  const headers = record(response.headers),
    data = record(response.data);
  const secondary =
    (typeof data.message === "string" &&
      /^(?:you have (?:exceeded|triggered) (?:a |the )?secondary rate limit)\b/i.test(
        data.message,
      )) ||
    (typeof data.documentation_url === "string" &&
      /^https:\/\/docs\.github\.com\/(?:en\/)?rest\/(?:using-the-rest-api\/rate-limits-for-the-rest-api|overview\/resources-in-the-rest-api)#(?:about-)?secondary-rate-limits$/.test(
        data.documentation_url,
      ));
  const seconds = (n: unknown) =>
    typeof n === "string" && /^\d{1,12}$/.test(n) ? Number(n) : 0;
  const retry = seconds(headers["retry-after"]),
    exhausted = headers["x-ratelimit-remaining"] === "0";
  if (code === 429 || (code === 403 && (secondary || exhausted || retry > 0))) {
    const now = Date.now();
    return new ReactionRejected(
      "rate_limited",
      Math.max(
        now + 60000,
        now + retry * 1000,
        exhausted ? seconds(headers["x-ratelimit-reset"]) * 1000 : 0,
      ),
    );
  }
  return new ReactionRejected(
    code === 403 || code === 401 ? "forbidden" : "unavailable",
  );
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
    !validId(task.actorId) ||
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
      throw reactionFailure(e);
    throw new AmbiguousExecution("Reaction dispatch unconfirmed");
  }
}
