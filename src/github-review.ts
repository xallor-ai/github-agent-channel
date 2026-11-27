import type { Octokit } from "@octokit/core";
import {
  AccessDenied,
  AmbiguousExecution,
  PullTargetRejected,
  type Task,
} from "./contracts.js";

function reviewScope(task: Task) {
  if (
    task.target.kind !== "pull_request" ||
    !task.target.revision ||
    task.target.revision.baseRepoId !== task.repositoryId ||
    task.target.revision.headRepoId !== task.repositoryId ||
    !Number.isSafeInteger(task.target.number) ||
    task.target.number < 1 ||
    !/^[0-9a-f]{40}$/i.test(task.target.revision.headSha) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(task.id)
  )
    throw new AccessDenied("Native reviews require a pinned pull request");
  const commit = task.target.revision.headSha;
  return {
    params: {
      owner: task.owner,
      repo: task.repo,
      pull_number: task.target.number,
    },
    commit,
    marker: `<!-- github-agent-channel:review:${task.id}:${commit} -->`,
    urlPrefix: `https://github.com/${task.owner}/${task.repo}/pull/${task.target.number}#pullrequestreview-`,
  };
}
type Review = {
  id: number | bigint;
  state: string;
  html_url: string;
  body?: string | null;
  commit_id: string | null;
  user: { login: string } | null;
};
function receipt(
  data: Review,
  scope: ReturnType<typeof reviewScope>,
  botLogin: string,
  body: string,
) {
  if (
    typeof data.id !== "number" ||
    !Number.isSafeInteger(data.id) ||
    data.id <= 0 ||
    data.state !== "COMMENTED" ||
    data.user?.login !== botLogin ||
    data.commit_id !== scope.commit ||
    data.body !== body ||
    data.html_url !== scope.urlPrefix + data.id
  )
    throw new AmbiguousExecution(
      "Cannot confirm GitHub review identity and commit",
    );
  return { id: data.id, url: data.html_url };
}
async function lookupMarker(
  scope: ReturnType<typeof reviewScope>,
  client: Octokit,
  botLogin: string,
  body: string,
) {
  let found: { id: number; url: string } | undefined;
  for (let page = 1; page <= 10; page++) {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { ...scope.params, page, per_page: 100 },
    );
    for (const r of data) {
      if (
        r.user?.login !== botLogin ||
        !r.body?.endsWith("\n\n" + scope.marker)
      )
        continue;
      if (found)
        throw new AmbiguousExecution("Multiple matching review markers");
      found = receipt(r, scope, botLogin, body);
    }
    if (data.length < 100) return found;
  }
  throw new AccessDenied("Review reconciliation exceeded scan limit");
}
export async function reconcileNativeReview(
  task: Task,
  id: number | undefined,
  client: Octokit,
  botLogin: string,
) {
  const scope = reviewScope(task);
  if (
    task.outcome?.publication.kind !== "review" ||
    (id !== undefined && (!Number.isSafeInteger(id) || id < 1))
  )
    throw new AccessDenied("Invalid review reconciliation request");
  if (id === undefined) {
    const found = await lookupMarker(
      scope,
      client,
      botLogin,
      `${task.outcome.text}\n\n${scope.marker}`,
    );
    if (!found) throw new AmbiguousExecution("No verified review marker");
    return found;
  }
  const { data } = await client.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
    { ...scope.params, review_id: id },
  );
  if (data.id !== id) throw new AmbiguousExecution("Review ID mismatch");
  return receipt(
    data,
    scope,
    botLogin,
    `${task.outcome.text}\n\n${scope.marker}`,
  );
}
export async function publishNativeReview(
  task: Task,
  text: string,
  client: Octokit,
  botLogin: string,
  authorize: () => Promise<void>,
  checkLocal: () => void,
) {
  const scope = reviewScope(task);
  const body = `${text}\n\n${scope.marker}`;
  if (!text.trim() || body.length > 20000)
    throw new AccessDenied("Invalid review body");
  // Re-check policy, actor and revision after all asynchronous reads and before POST.
  const check = async () => {
    try {
      await authorize();
    } catch (e) {
      if (e instanceof PullTargetRejected) throw e;
      throw new AccessDenied("Cannot confirm authorization for native review");
    }
  };
  await check();
  checkLocal();
  try {
    const existing = await lookupMarker(scope, client, botLogin, body);
    if (existing) return existing;
  } catch (error) {
    // A conflicting observed task marker still requires reconciliation. GET transport,
    // parsing and scan-limit failures occurred before any write attempt.
    if (error instanceof AmbiguousExecution) throw error;
    throw new AccessDenied(
      "Cannot finish native review preflight before dispatch",
    );
  }
  await check();
  // No await between local generation/policy validation and dispatch.
  checkLocal();
  try {
    const { data } = await client.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        ...scope.params,
        commit_id: scope.commit,
        event: "COMMENT",
        body,
      },
    );
    return receipt(data, scope, botLogin, body);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 408
    )
      throw new AccessDenied("GitHub rejected native review");
    throw new AmbiguousExecution(
      "Native review delivery uncertain; verify before resolving",
    );
  }
}
