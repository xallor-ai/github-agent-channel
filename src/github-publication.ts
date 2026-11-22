import {
  AccessDenied,
  AmbiguousExecution,
  type Binding,
  type PublicationRequest,
  type Task,
} from "./contracts.js";
import type { Octokit } from "@octokit/core";
type Proposal = Extract<PublicationRequest, { kind: "pull_request" }>;
function safePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\\:%\x00-\x1f\x7f]/.test(path) &&
    path.normalize("NFC") === path &&
    path
      .split("/")
      .every(
        (p) =>
          p &&
          p !== "." &&
          p !== ".." &&
          !/[. ]$/.test(p) &&
          !/^\.git$/i.test(p) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      ) &&
    !/^\.github\/workflows(?:\/|$)/i.test(path)
  );
}
export function validateProposal(
  task: Task,
  policy: Binding["writePolicy"],
  proposal: Proposal,
): void {
  if (!policy || proposal.baseBranch !== policy.baseBranch)
    throw new AccessDenied(
      "PR write policy is not enabled for this base branch",
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      task.id,
    ) ||
    !/^[0-9a-f]{40}$/.test(proposal.baseSha)
  )
    throw new AccessDenied("Invalid publication task or base SHA");
  if (
    !proposal.title.trim() ||
    proposal.title.length > 256 ||
    proposal.body.length > 20000
  )
    throw new AccessDenied("Invalid PR title or body");
  if (
    !proposal.files.length ||
    proposal.files.length > (policy.maxFiles ?? 100)
  )
    throw new AccessDenied("File count exceeds write policy");
  const seen: string[] = [];
  const casing = new Map<string, string>();
  let bytes = 0;
  for (const file of proposal.files) {
    const path = file.path;
    if (
      !safePath(path) ||
      !policy.allowedPaths.some((rule) => {
        const prefix = rule.endsWith("/**")
          ? rule.slice(0, -3)
          : rule.endsWith("/")
            ? rule.slice(0, -1)
            : undefined;
        return prefix !== undefined
          ? safePath(prefix) && path.startsWith(prefix + "/")
          : safePath(rule) && path === rule;
      })
    )
      throw new AccessDenied("File path is outside write policy");
    const lower = path.toLowerCase();
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      const previous = casing.get(prefix.toLowerCase());
      if (previous && previous !== prefix)
        throw new AccessDenied("Conflicting path casing");
      casing.set(prefix.toLowerCase(), prefix);
    }
    if (
      seen.some(
        (p) =>
          p === lower || p.startsWith(lower + "/") || lower.startsWith(p + "/"),
      )
    )
      throw new AccessDenied("Duplicate or conflicting file paths");
    seen.push(lower);
    if (file.content !== null && typeof file.content !== "string")
      throw new AccessDenied("Only UTF-8 regular files are supported");
    bytes +=
      file.content === null ? 0 : Buffer.byteLength(file.content, "utf8");
  }
  if (bytes > (policy.maxBytes ?? 512 * 1024))
    throw new AccessDenied("File bytes exceed write policy");
}
export async function publishDraftPullRequest(
  task: Task,
  proposal: Proposal,
  client: Octokit,
  authorize: () => Promise<void>,
): Promise<{ id: number; url: string }> {
  const scope = { owner: task.owner, repo: task.repo };
  const body =
    task.target.kind === "repository"
      ? proposal.body
      : `${proposal.body}\n\nRelated ${task.target.kind === "issue" ? "issue" : "pull request"}: #${task.target.number}.`;
  const branch = `channel/${task.id}`;
  const base = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    ...scope,
    ref: `heads/${proposal.baseBranch}`,
  });
  if (base.data.object.sha !== proposal.baseSha)
    throw new AccessDenied("Remote base branch changed");
  try {
    await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      ...scope,
      ref: `heads/${branch}`,
    });
    throw new AccessDenied(
      "Task branch already exists; reconciliation required",
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  const commit = await client.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { ...scope, commit_sha: proposal.baseSha },
  );
  const tree = await client.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { ...scope, tree_sha: commit.data.tree.sha, recursive: "1" },
  );
  if (tree.data.truncated || !Array.isArray(tree.data.tree))
    throw new AccessDenied("Cannot validate incomplete repository tree");
  const entries = proposal.files.map((file) => {
    const lower = file.path.toLowerCase();
    for (const entry of tree.data.tree) {
      if (!entry.path) throw new AccessDenied("Invalid repository tree");
      const old = entry.path.toLowerCase();
      if (
        (old === lower && entry.path !== file.path) ||
        old.startsWith(lower + "/") ||
        (lower.startsWith(old + "/") &&
          (entry.type !== "tree" || !file.path.startsWith(entry.path + "/")))
      )
        throw new AccessDenied("Repository path or case conflict");
    }
    const existing = tree.data.tree.find((entry) => entry.path === file.path);
    if (
      existing &&
      (existing.type !== "blob" ||
        !["100644", "100755"].includes(existing.mode ?? ""))
    )
      throw new AccessDenied("Only regular file changes are supported");
    if (file.content === null && !existing)
      throw new AccessDenied("Cannot delete missing file");
    return {
      path: file.path,
      mode: (existing?.mode ?? "100644") as "100644" | "100755",
      type: "blob" as const,
      sha: null as string | null,
    };
  });
  // Static token has no auth-app retry hooks. Each individual mutation is gated
  // by a fresh authorization read; uncertain writes are never replayed here.
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    await authorize();
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!status || status >= 500 || status === 408)
        throw new AmbiguousExecution(
          "GitHub PR publication is uncertain; reconcile before any retry",
        );
      throw error;
    }
  };
  const validSha = (sha: unknown): string => {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
      throw new AmbiguousExecution("Incomplete GitHub mutation response");
    return sha;
  };
  for (const [i, file] of proposal.files.entries()) {
    const content = file.content;
    if (content !== null) {
      const blob = await mutate(() =>
        client.request("POST /repos/{owner}/{repo}/git/blobs", {
          ...scope,
          content: Buffer.from(content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      );
      entries[i]!.sha = validSha(blob.data.sha);
    }
  }
  const newTree = await mutate(() =>
    client.request("POST /repos/{owner}/{repo}/git/trees", {
      ...scope,
      base_tree: commit.data.tree.sha,
      tree: entries,
    }),
  );
  const treeSha = validSha(newTree.data.sha);
  const newCommit = await mutate(() =>
    client.request("POST /repos/{owner}/{repo}/git/commits", {
      ...scope,
      message: proposal.title,
      tree: treeSha,
      parents: [proposal.baseSha],
    }),
  );
  const commitSha = validSha(newCommit.data.sha);
  const ref = await mutate(() =>
    client.request("POST /repos/{owner}/{repo}/git/refs", {
      ...scope,
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    }),
  );
  validSha(ref.data.object?.sha);
  const pr = await mutate(() =>
    client.request("POST /repos/{owner}/{repo}/pulls", {
      ...scope,
      title: proposal.title,
      body,
      head: branch,
      base: proposal.baseBranch,
      draft: true,
    }),
  );
  if (
    typeof pr.data.id !== "number" ||
    !Number.isSafeInteger(pr.data.id) ||
    pr.data.id <= 0 ||
    !pr.data.html_url?.startsWith(
      `https://github.com/${task.owner}/${task.repo}/pull/`,
    )
  )
    throw new AmbiguousExecution("Incomplete GitHub PR response");
  return { id: pr.data.id, url: pr.data.html_url };
}
