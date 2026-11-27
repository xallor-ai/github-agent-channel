import type { Octokit } from "@octokit/core";
import { z } from "zod";
import { AccessDenied, AmbiguousExecution, type Task } from "./contracts.js";

const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// Construct the reference on the server. Model prose, a marker alone, or a
// pasted URL is never evidence that the question was published.
export async function clarificationComment(
  client: Octokit,
  task: Task,
  botLogin: string,
  authorizeWrite?: () => Promise<void>,
) {
  const { target, source, outcome, owner, repo } = task;
  if (
    source.event !== "issue_comment" ||
    source.action !== "created" ||
    !positive(source.commentId) ||
    target.kind === "repository" ||
    !positive(target.number) ||
    !positive(task.actorId) ||
    !z.uuid().safeParse(task.id).success ||
    outcome?.publication.kind !== "clarification" ||
    !outcome.text.trim() ||
    outcome.text.length > 2000 ||
    (target.kind === "pull_request" &&
      (!target.revision ||
        target.revision.baseRepoId !== task.repositoryId ||
        target.revision.headRepoId !== task.repositoryId))
  )
    throw new AccessDenied("Invalid clarification scope");
  const marker = `<!-- github-agent-channel:${task.id} -->`;
  const version =
    target.kind === "pull_request" && target.revision
      ? `\n\nPR base: ${target.revision.baseSha}; head: ${target.revision.headSha}`
      : "";
  const body = `${outcome.text}\n\n请在本线程回答。如需指定这个问题，请以 \`/answer ${task.id} 你的答复\` 开头。${version}\n\n${marker}`;
  const params = { owner, repo, issue_number: target.number };
  const issueUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${target.number}`;
  const thread = `https://github.com/${owner}/${repo}/${target.kind === "issue" ? "issues" : "pull"}/${target.number}#issuecomment-`;
  function verify(c: {
    id: number | bigint;
    html_url: string;
    issue_url: string;
    created_at: string;
    body?: string | null;
    user: { login: string; type: string } | null;
  }) {
    const time = z.iso.datetime().safeParse(c.created_at);
    if (
      !positive(c.id) ||
      c.body !== body ||
      c.user?.login !== botLogin ||
      c.user.type !== "Bot" ||
      c.issue_url !== issueUrl ||
      c.html_url !== thread + c.id ||
      !time.success
    )
      throw new AmbiguousExecution("Unverified GitHub question comment");
    return { id: c.id, url: c.html_url, createdAt: Date.parse(time.data) };
  }
  let observed: ReturnType<typeof verify> | undefined;
  for (let page = 1; page <= 10; page++) {
    const { data, headers } = await client
      .request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        ...params,
        per_page: 100,
        page,
      })
      .catch(() => {
        throw new AccessDenied("Cannot inspect clarification thread");
      });
    for (const c of data) {
      if (c.user?.login !== botLogin || !c.body?.endsWith("\n\n" + marker))
        continue;
      if (observed) throw new AmbiguousExecution("Multiple question markers");
      observed = verify(c);
    }
    if (!headers.link?.includes('rel="next"') && data.length < 100) break;
    if (page === 10)
      throw new AmbiguousExecution("Question audit scan incomplete");
  }
  if (observed) return observed;
  if (!authorizeWrite) throw new AmbiguousExecution("Question not confirmed");
  // The source was a signed comment. Recheck its stable identity and parent
  // immediately before the final actor/target/closure check and the only POST.
  const { data: c } = await client
    .request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: source.commentId,
    })
    .catch(() => {
      throw new AccessDenied("Source comment unavailable");
    });
  if (
    c.id !== source.commentId ||
    c.issue_url !== issueUrl ||
    c.user?.id !== task.actorId ||
    c.user.type !== "User"
  )
    throw new AccessDenied("Original clarification thread not verified");
  await authorizeWrite();
  const response = await client
    .request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      ...params,
      body,
    })
    .catch((e: unknown) => {
      const status =
        e && typeof e === "object" && "status" in e ? e.status : null;
      if (
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408
      )
        throw new AccessDenied("GitHub rejected question creation");
      throw new AmbiguousExecution("Question write unconfirmed");
    });
  if (response.status !== 201)
    throw new AmbiguousExecution("Question creation unconfirmed");
  return verify(response.data);
}
